package pigkernel

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)


type SessionOptions struct {
	Database string
	Identity string
	Model ModelSpec
	Provider ProviderBridge
	Tools []ToolSpec
	Codemode *CodemodeOptions
	McpServers []McpServerSpec
	Instructions string
	ThinkingLevel string
	RequestId string
	Compaction *CompactionThresholds
	OnEvent func(event map[string]any)
	OnToolCall func(call ToolCallRecord)
	ToolResults ToolResultRenderer
}

type CompactionThresholds struct {
	ReserveTokens int
	KeepRecentTokens int
}

type ToolCallRecord struct {
	Name string
	Arguments map[string]any
	Result string
	IsError bool
}

type SessionInspect struct {
	SessionId string
	SessionFile string
	Model string
	Messages []any
	ActiveTools []string
	RegisteredTools []string
	LoadedExtensions []string
	ToolCalls []string
}

type SessionTurn struct {
	Text string
	StopReason string
	ErrorMessage string
	Usage *Usage
	Inspect SessionInspect
}

type Usage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Total      int `json:"total"`
}

type sessionContinuation struct {
	submission durable.Submission
	err        error
}

type Session struct {
	kernel       *Kernel
	conversation harness.Conversation
	extension    *durable.Extension
	connections  []*mcpConnection
	recorder     *callRecorder

	identity     string
	model        ModelSpec
	instructions string
	toolNames    []string
	loaded       []string
	requestId    string
	OnEvent func(event map[string]any)
	OnToolCall func(call ToolCallRecord)

	mutex          sync.Mutex
	closed         bool
	stopped        bool
	acceptingInput bool
	interrupted    bool
	continuation   chan sessionContinuation
	compactions map[durable.TaskId]bool
}

func OpenSession(ctx context.Context, options SessionOptions) (*Session, error) {
	resident, err := openResident(ctx, options.Database)
	if err != nil {
		return nil, err
	}
	recorder := &callRecorder{}
	registrations := toolRegistrations(options.Tools, recorder, options.ToolResults)
	connections, mcpTools, err := connectMcpServers(ctx, options.McpServers, recorder)
	if err != nil {
		return nil, err
	}
	registrations = append(registrations, mcpTools...)
	history := &historyTool{}
	if !toolRegistered(options.Tools, historyToolName) {
		registrations = append(registrations, toolRegistrations([]ToolSpec{history.spec()}, recorder, options.ToolResults)...)
	}
	extension := &durable.Extension{Name: extensionName(options.Identity), Tools: registrations}
	extensions := []*durable.Extension{extension}
	if options.Codemode != nil {
		codemodeExtension, err := CodemodeExtension(*options.Codemode)
		if err != nil {
			closeMcpServers(connections)
			return nil, fmt.Errorf("pig kernel: the codemode extension is refused: %w", err)
		}
		registrations = append(registrations, codemodeExtension.Tools...)
		extension.Tools = registrations
		extensions = append(extensions, codemodeExtension)
	}
	for _, installed := range extensions {
		if err := resident.registry.Install(installed); err != nil {
			closeMcpServers(connections)
			return nil, fmt.Errorf("pig kernel: the session extension is refused: %w", err)
		}
	}
	providerID := providerName(options.Identity)
	if options.Compaction != nil {
		RegisterCompactionPolicy(providerID+"/"+options.Model.Id,
			options.Compaction.ReserveTokens, options.Compaction.KeepRecentTokens)
	}
	provider := ai.CreateProvider(ai.CreateProviderOptions{
		ID: providerID,
		Auth: ai.ProviderAuth{APIKey: &ai.APIKeyAuth{
			Name: "Graph",
			Resolve: func(context.Context, ai.APIKeyAuthInput) (*ai.AuthResult, error) {
				return &ai.AuthResult{Auth: ai.ModelAuth{APIKey: "graph-gated-binding"}}, nil
			},
		}},
		Models: ai.AnyModels([]*ai.Model{buildModel(options.Model, providerID)}),
		API:    BridgeAPI(options.Provider, apiOf(options.Model)),
	})
	resident.models.SetProvider(provider)
	change := harness.AgentChange{
		Model:        harness.SetTo(durable.ModelRef{Provider: providerID, ModelId: options.Model.Id}),
		Instructions: harness.SetTo(options.Instructions),
		Tools:        harness.SetTo(harness.ToolChange{List: registrations}),
		ModelTools:   harness.SetTo(harness.ToolChange{List: registrations}),
		Extensions:   harness.SetTo(harness.ExtensionChange{List: extensions}),
	}
	conversation, err := conversationFor(ctx, resident.kernel, options.Identity, change)
	if err != nil {
		closeMcpServers(connections)
		return nil, err
	}
	names := []string{}
	for _, registration := range registrations {
		names = append(names, registration.ToolSchema.Name)
	}
	session := &Session{
		kernel: resident.kernel, conversation: conversation, extension: extension,
		connections: connections, recorder: recorder,
		identity: options.Identity, model: options.Model, instructions: options.Instructions,
		toolNames: names, loaded: []string{extension.Name}, requestId: options.RequestId,
		OnEvent: options.OnEvent, OnToolCall: options.OnToolCall,
	}
	history.session = session
	return session, nil
}

func (session *Session) Prompt(ctx context.Context, text string) (SessionTurn, error) {
	return session.PromptContent(ctx, ai.UserText(text))
}

func (session *Session) PromptContent(ctx context.Context, content ai.UserContent) (SessionTurn, error) {
	session.mutex.Lock()
	if session.closed {
		session.mutex.Unlock()
		return SessionTurn{}, fmt.Errorf("pig kernel: the session is closed")
	}
	session.acceptingInput = true
	session.interrupted = false
	session.mutex.Unlock()
	defer func() {
		session.mutex.Lock()
		session.acceptingInput = false
		session.mutex.Unlock()
	}()

	events, err := harness.WatchEvents(ctx, session.kernel.Harness(), session.conversation.Id())
	if err != nil {
		return SessionTurn{}, err
	}
	events.Start(func(_ context.Context, batch []harness.AgentEvent) error {
		for _, event := range batch {
			session.emit(event)
		}
		return nil
	})
	defer func() { _, _ = events.Stop() }()

	existing, err := session.conversation.Commit(ctx, func(tx durable.Tx) (any, error) {
		record, err := tx.SubmissionByRequest(session.conversation.Id(), session.admissionId())
		if err != nil {
			return nil, err
		}
		return record, nil
	})
	if err != nil {
		return SessionTurn{}, err
	}
	var submission durable.Submission
	if record, ok := existing.(*durable.SubmissionRecord); ok && record != nil {
		admitted, err := session.kernel.Harness().Submission(ctx, record.Id)
		if err != nil {
			return SessionTurn{}, err
		}
		submission = admitted
	} else {
		requestId := session.admissionId()
			submitted, err := session.conversation.Submit(ctx, durable.SubmissionDraft{
				Type:      durable.SubmissionTypeInput,
				Content:   content,
				RequestId: &requestId,
				WhenBusy:  durable.WhenBusyReject,
			})
		if err != nil {
			return SessionTurn{}, err
		}
		submission = submitted
	}
	var settled durable.SettledSubmissionRecord
	for {
		record, waitErr := submission.Wait(ctx)
		if waitErr != nil {
			return SessionTurn{}, waitErr
		}
		session.mutex.Lock()
		next := session.continuation
		if next == nil {
			session.acceptingInput = false
		}
		session.mutex.Unlock()
		if next == nil {
			settled = record
			break
		}
		var resumed sessionContinuation
		select {
		case resumed = <-next:
		case <-ctx.Done():
			return SessionTurn{}, ctx.Err()
		}
		if resumed.err != nil {
			return SessionTurn{}, resumed.err
		}
		session.mutex.Lock()
		if session.continuation == next {
			session.continuation = nil
		}
		session.mutex.Unlock()
		submission = resumed.submission
	}
	turn := SessionTurn{StopReason: string(settled.Status)}
	if settled.Answer != nil {
		text, stopReason, usage, err := answerText(ctx, session.conversation, *settled.Answer)
		if err != nil {
			return SessionTurn{}, err
		}
		turn.Text = text
		if stopReason != "" {
			turn.StopReason = stopReason
		}
		turn.Usage = usage
	}
	if settled.Status != durable.SubmissionDone {
		turn.ErrorMessage = fmt.Sprintf("The durable input was not answered: %s", settled.Status)
		if detail, ok := settled.Detail.(string); ok && strings.TrimSpace(detail) != "" {
			turn.ErrorMessage += ": " + detail
		}
	}
	session.mutex.Lock()
	interrupted := session.interrupted
	session.mutex.Unlock()
	if interrupted {
		turn.StopReason = "aborted"
		turn.ErrorMessage = ""
	}
	turn.Inspect = session.Inspect()
	return turn, nil
}

func (session *Session) Steer(ctx context.Context, text string) error {
	return session.SteerWithRequestID(ctx, text, newRequestId())
}

func (session *Session) SteerWithRequestID(ctx context.Context, text, id string) error {
	session.mutex.Lock()
	accepting := session.acceptingInput
	closed := session.closed
	session.mutex.Unlock()
	if closed {
		return fmt.Errorf("pig kernel: the session is closed")
	}
	if !accepting {
		return fmt.Errorf("pig kernel: the session is no longer accepting steering messages")
	}
	requestId := session.admissionId() + ":continuation:" + id
	_, err := session.conversation.Submit(ctx, durable.SubmissionDraft{
		Type:      durable.SubmissionTypeInput,
		Content:   ai.UserText(text),
		RequestId: &requestId,
		WhenBusy:  durable.WhenBusySteer,
	})
	return err
}

func (session *Session) Interrupt(ctx context.Context, text *string) error {
	return session.InterruptWithRequestID(ctx, text, newRequestId())
}

func (session *Session) InterruptWithRequestID(ctx context.Context, text *string, id string) error {
	session.mutex.Lock()
	if session.closed || !session.acceptingInput {
		session.mutex.Unlock()
		return fmt.Errorf("pig kernel: the session is no longer accepting interruption")
	}
	if session.continuation != nil {
		session.mutex.Unlock()
		return fmt.Errorf("pig kernel: an interruption is already pending")
	}
	replacement := text != nil && *text != ""
	session.interrupted = !replacement
	var next chan sessionContinuation
	if replacement {
		next = make(chan sessionContinuation, 1)
		session.continuation = next
	}
	session.mutex.Unlock()
	if !replacement {
		abortContext := context.Background()
		if ctx != nil {
			abortContext = context.WithoutCancel(ctx)
		}
		go func() {
			_ = session.conversation.Abort(abortContext, &durable.ConversationAbortOptions{})
		}()
		return nil
	}
	if err := session.conversation.Abort(ctx, &durable.ConversationAbortOptions{}); err != nil {
		if next != nil {
			next <- sessionContinuation{err: err}
		}
		return err
	}
	requestId := session.admissionId() + ":continuation:" + id
	submitted, err := session.conversation.Submit(ctx, durable.SubmissionDraft{
		Type: durable.SubmissionTypeInput, Content: ai.UserText(*text), RequestId: &requestId,
	})
	next <- sessionContinuation{submission: submitted, err: err}
	return err
}

func (session *Session) Stop(ctx context.Context) error {
	session.mutex.Lock()
	session.interrupted = true
	session.mutex.Unlock()
	return session.conversation.Abort(ctx, &durable.ConversationAbortOptions{})
}

func (session *Session) Inspect() SessionInspect {
	names := []string{}
	for _, name := range session.toolNames {
		names = append(names, name)
	}
	return SessionInspect{
		SessionId:        fmt.Sprintf("%d", session.conversation.Id()),
		SessionFile:      fmt.Sprintf("durable:%d", session.conversation.Id()),
		Model:            session.model.Id,
		Messages:         []any{},
		ActiveTools:      names,
		RegisteredTools:  names,
		LoadedExtensions: session.loaded,
		ToolCalls:        session.recorder.calls(),
	}
}

func (session *Session) Close() error {
	session.mutex.Lock()
	if session.closed {
		session.mutex.Unlock()
		return nil
	}
	session.closed = true
	session.mutex.Unlock()
	closeMcpServers(session.connections)
	return nil
}

func (session *Session) admissionId() string {
	if session.requestId != "" {
		return session.requestId
	}
	return session.identity
}

func (session *Session) emit(event harness.AgentEvent) {
	if session.OnEvent == nil {
		return
	}
	if end, ok := event.(harness.CompactionEndEvent); ok {
		if !session.compactionReported(end.TaskId) {
			session.reportThresholdCompaction(end)
		}
		return
	}
	for _, report := range translateEvent(event) {
		session.OnEvent(report)
	}
}

