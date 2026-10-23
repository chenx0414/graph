package pigkernel

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)

// One resident session on the PiG kernel.
//
// The kernel is resident: it stays open for the life of the daemon and holds
// the durable conversations of every identity it has seen. A session is one
// identity's view of that kernel: its model, its tools, its instructions and
// its events.
//
// The division of labour between the daemon and the kernel is documented in
// docs/architecture.md, section daemon 与内核的分工.

// SessionOptions configure one resident session.
type SessionOptions struct {
	// Database is the formal Graph database the durable records live in.
	Database string
	// Identity is the stable identity of the session: the Graph instance.
	Identity string
	// Model is the model the session sends to.
	Model ModelSpec
	// Provider is the daemon's model channel.
	Provider ProviderBridge
	// Tools are the Graph tools the session may call.
	Tools []ToolSpec
	// McpServers are the MCP servers the kernel connects natively. Their
	// tools reach the model under PiG's own `mcp__<server>__<tool>` names.
	McpServers []McpServerSpec
	// Instructions are the system instructions of the session.
	Instructions string
	// ThinkingLevel is the requested reasoning level.
	ThinkingLevel string
	// RequestId is the admission identity of the next input. The same id is
	// the same input, so a retried admission is never sent twice.
	RequestId string
	// OnEvent receives the kernel's events.
	OnEvent func(event map[string]any)
	// OnToolCall receives every executed tool call.
	OnToolCall func(call ToolCallRecord)
}

// ToolCallRecord is one executed tool call.
type ToolCallRecord struct {
	// Name is the tool the model called.
	Name string
	// Arguments are the arguments the model sent.
	Arguments map[string]any
	// Result is the text the tool returned.
	Result string
	// IsError reports whether the tool failed.
	IsError bool
}

// SessionInspect is the session's own view of itself.
type SessionInspect struct {
	// SessionId is the durable conversation the session runs in.
	SessionId string
	// SessionFile names the durable record the transcript lives in.
	SessionFile string
	// Model is the model the session sends to.
	Model string
	// Messages are the transcript messages the session holds.
	Messages []any
	// ActiveTools are the tools the session may call.
	ActiveTools []string
	// RegisteredTools are the tools the session registered.
	RegisteredTools []string
	// LoadedExtensions are the extensions the session loaded.
	LoadedExtensions []string
	// ToolCalls are the tool calls the session made.
	ToolCalls []string
}

// SessionTurn is what one prompt produced.
type SessionTurn struct {
	// Text is the assistant answer.
	Text string
	// StopReason is the reason the answer ended.
	StopReason string
	// ErrorMessage is the failure, when the turn failed.
	ErrorMessage string
	// Usage is the token usage the answer reported.
	Usage *Usage
	// Inspect is the session's own view after the turn.
	Inspect SessionInspect
}

// Usage is the token usage one assistant message reported.
type Usage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Total      int `json:"total"`
}

// Session is one resident session on the kernel.
type Session struct {
	kernel      *Kernel
	conversation harness.Conversation
	extension   *durable.Extension
	connections []*mcpConnection
	recorder    *callRecorder

	identity    string
	model       ModelSpec
	instructions string
	toolNames   []string
	loaded      []string
	requestId   string
	// OnEvent receives the kernel's events.
	OnEvent func(event map[string]any)
	// OnToolCall receives every executed tool call.
	OnToolCall func(call ToolCallRecord)

	mutex         sync.Mutex
	closed        bool
	acceptingInput bool
	interrupted   bool
	continuation  chan struct{}
}

// OpenSession opens one resident session on the kernel.
//
// The kernel of the database is opened once and kept: every session of that
// database shares it, and so do the durable conversations they address.
func OpenSession(ctx context.Context, options SessionOptions) (*Session, error) {
	resident, err := openResident(ctx, options.Database)
	if err != nil {
		return nil, err
	}
	recorder := &callRecorder{}
	registrations := toolRegistrations(options.Tools, recorder)
	connections, mcpTools, err := connectMcpServers(ctx, options.McpServers, recorder)
	if err != nil {
		return nil, err
	}
	registrations = append(registrations, mcpTools...)
	extension := &durable.Extension{Name: extensionName(options.Identity), Tools: registrations}
	if err := resident.registry.Install(extension); err != nil {
		closeMcpServers(connections)
		return nil, fmt.Errorf("pig kernel: the session extension is refused: %w", err)
	}
	// The model is the daemon's: the kernel asks the daemon's own stream for
	// the answer, and the daemon admits the send.
	providerID := providerName(options.Identity)
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
		Extensions:   harness.SetTo(harness.ExtensionChange{List: []*durable.Extension{extension}}),
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
	return session, nil
}

// Prompt sends one input and returns the turn it produced.
func (session *Session) Prompt(ctx context.Context, text string) (SessionTurn, error) {
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

	// The same admission is the same input: an input the kernel already
	// accepted is never sent twice.
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
			Content:   ai.UserText(text),
			RequestId: &requestId,
			WhenBusy:  durable.WhenBusyReject,
		})
		if err != nil {
			return SessionTurn{}, err
		}
		submission = submitted
	}
	settled, err := submission.Wait(ctx)
	if err != nil {
		return SessionTurn{}, err
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
	}
	turn.Inspect = session.Inspect()
	return turn, nil
}

// Compact prepares the next operation's prompt.
func (session *Session) Compact(ctx context.Context, instructions string) error {
	session.mutex.Lock()
	if session.closed {
		session.mutex.Unlock()
		return fmt.Errorf("pig kernel: the session is closed")
	}
	session.mutex.Unlock()
	var prompt *string
	if instructions != "" {
		value := instructions
		prompt = &value
	}
	task, err := session.conversation.Compact(ctx, prompt)
	if err != nil {
		return err
	}
	result, err := session.kernel.Harness().WaitForTask(ctx, task)
	if err != nil {
		return err
	}
	if result.State.Outcome != nil && result.State.Outcome.Status != durable.OutcomeCompleted {
		return fmt.Errorf("pig kernel: the compaction did not complete")
	}
	return nil
}

// Steer injects a message into the running turn.
func (session *Session) Steer(ctx context.Context, text string) error {
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
	requestId := session.admissionId() + ":continuation:" + newRequestId()
	_, err := session.conversation.Submit(ctx, durable.SubmissionDraft{
		Type:      durable.SubmissionTypeInput,
		Content:   ai.UserText(text),
		RequestId: &requestId,
		WhenBusy:  durable.WhenBusySteer,
	})
	return err
}

// Interrupt aborts the running turn. When text is present it becomes the next
// prompt in the same session, keeping the interrupted operation alive.
func (session *Session) Interrupt(ctx context.Context, text *string) error {
	session.mutex.Lock()
	if session.closed {
		session.mutex.Unlock()
		return fmt.Errorf("pig kernel: the session is closed")
	}
	if !session.acceptingInput {
		session.mutex.Unlock()
		return fmt.Errorf("pig kernel: the session is no longer accepting interruption")
	}
	session.interrupted = true
	session.mutex.Unlock()
	if err := session.conversation.Abort(ctx, &durable.ConversationAbortOptions{}); err != nil {
		return err
	}
	if text == nil || *text == "" {
		return nil
	}
	requestId := session.admissionId() + ":continuation:" + newRequestId()
	_, err := session.conversation.Submit(ctx, durable.SubmissionDraft{
		Type:      durable.SubmissionTypeInput,
		Content:   ai.UserText(*text),
		RequestId: &requestId,
	})
	return err
}

// Stop soft-stops the running turn. The session and its transcript are kept.
func (session *Session) Stop(ctx context.Context) error {
	return session.conversation.Abort(ctx, &durable.ConversationAbortOptions{})
}

// Inspect is the session's own view of itself.
func (session *Session) Inspect() SessionInspect {
	names := []string{}
	for _, name := range session.toolNames {
		names = append(names, name)
	}
	return SessionInspect{
		SessionId:       fmt.Sprintf("%d", session.conversation.Id()),
		SessionFile:     fmt.Sprintf("durable:%d", session.conversation.Id()),
		Model:           session.model.Id,
		Messages:        []any{},
		ActiveTools:     names,
		RegisteredTools: names,
		LoadedExtensions: session.loaded,
		ToolCalls:       session.recorder.calls(),
	}
}

// Close ends the session. The kernel stays open: it holds the durable
// conversations of every identity.
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

// admissionId is the identity of the session's next input.
func (session *Session) admissionId() string {
	if session.requestId != "" {
		return session.requestId
	}
	return session.identity
}

// emit reports one kernel event to the daemon.
func (session *Session) emit(event harness.AgentEvent) {
	if session.OnEvent == nil {
		return
	}
	for _, report := range translateEvent(event) {
		session.OnEvent(report)
	}
}

// translateEvent turns one kernel event into the events the daemon reads.
//
// The daemon's own event names are the SDK's: a message starts, updates and
// ends, a tool call starts and ends. The kernel's events carry the same
// information under its own names, so they are translated here rather than
// leaking a second vocabulary into the daemon.
func translateEvent(event harness.AgentEvent) []map[string]any {
	switch value := event.(type) {
	case harness.RunStartEvent:
		return []map[string]any{{"type": "agent_start"}}
	case harness.RunEndEvent:
		return []map[string]any{{"type": "agent_end"}}
	case harness.TurnStartEvent:
		return []map[string]any{{"type": "turn_start"}}
	case harness.TurnEndEvent:
		return []map[string]any{{"type": "turn_end"}}
	case harness.MessageStartEvent:
		message := messageMap(value.Message)
		return []map[string]any{{"type": "message_start", "message": message}}
	case harness.MessageUpdateEvent:
		reports := []map[string]any{}
		for _, change := range value.Changes {
			if change.Type != "text_delta" {
				continue
			}
			reports = append(reports, map[string]any{
				"type": "message_update",
				"assistantMessageEvent": map[string]any{
					"type": "text_delta", "contentIndex": change.ContentIndex, "delta": change.Delta,
				},
			})
		}
		return reports
	case harness.MessageEndEvent:
		reports := []map[string]any{}
		for _, message := range value.Entry.Model {
			report := messageMap(message)
			reports = append(reports, map[string]any{"type": "message_end", "message": report})
		}
		return reports
	case harness.ToolExecutionStartEvent:
		args := map[string]any{}
		if value.Args != nil {
			for name, item := range value.Args.All() {
				args[name] = item
			}
		}
		return []map[string]any{{
			"type": "tool_execution_start", "toolName": value.ToolName, "toolCallId": value.ToolCallId,
			"args": args,
		}}
	case harness.ToolExecutionEndEvent:
		result := map[string]any{"content": []any{}}
		failed := true
		if value.Entry != nil {
			for _, message := range value.Entry.Model {
				if outcome, ok := message.(ai.ToolResultMessage); ok {
					text := toolResultText(outcome)
					result["content"] = []any{map[string]any{"type": "text", "text": text}}
					failed = outcome.IsError
				}
			}
		}
		return []map[string]any{{
			"type": "tool_execution_end", "toolName": value.ToolName, "toolCallId": value.ToolCallId,
			"isError": failed, "result": result,
		}}
	}
	return nil
}

// messageMap reads one transcript message as the daemon's own map.
func messageMap(message ai.Message) map[string]any {
	body, err := json.Marshal(message)
	if err != nil {
		return map[string]any{}
	}
	decoded := map[string]any{}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return map[string]any{}
	}
	return decoded
}

// toolResultText reads the text of one tool result.
func toolResultText(message ai.ToolResultMessage) string {
	text := ""
	for _, block := range message.Content {
		if content, ok := block.(ai.TextContent); ok {
			text += content.Text
		}
	}
	return text
}
