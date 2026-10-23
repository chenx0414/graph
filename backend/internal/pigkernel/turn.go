package pigkernel

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)

// One agent turn on the PiG kernel.
//
// The Graph daemon owns every business fact, credential and admission rule;
// the kernel owns the execution history. A turn therefore arrives with the
// model, the tools and the prompt already decided by the daemon, and leaves
// with the answer and the durable records that produced it.

// ModelSpec is the model a turn runs on, described in the daemon's terms.
//
// The credential travels with the specification because the kernel performs the
// provider call itself: PiG's ai package speaks the provider protocols, while
// the daemon decides which model, which key and which admission apply.
type ModelSpec struct {
	ProviderID    string
	Id            string
	Name          string
	API           string
	BaseURL       string
	APIKey        string
	Headers       map[string]string
	ContextWindow int
	MaxTokens     int
	Reasoning     bool
	ThinkingLevel string
}

// ToolSpec is one tool the model may call during the turn.
type ToolSpec struct {
	Name        string
	Description string
	Parameters  map[string]any
	// Execute runs the tool. The daemon owns the admission and the side
	// effects; the kernel only carries the call and its result.
	Execute func(ctx context.Context, args map[string]any) (string, error)
	// Result runs the tool and returns the SDK's own tool result. It is the
	// faithful shape: a tool that returns an image or structured details
	// keeps them. It wins over Execute when both are set.
	Result func(ctx context.Context, args map[string]any) (any, error)
}

// TurnOptions configure one turn.
type TurnOptions struct {
	// Database is the formal Graph database the durable records live in.
	Database string
	// Identity is the stable identity of the session, the instance in Graph.
	Identity string
	// Model is the model the turn sends to.
	Model ModelSpec
	// Tools are the tools the model may call.
	Tools []ToolSpec
	// McpServers are the MCP servers the kernel connects natively. Their tools
	// reach the model under PiG's own `mcp__<server>__<tool>` names.
	McpServers []McpServerSpec
	// Instructions are the system instructions of the session.
	Instructions string
	// Prompt is the user input of the turn.
	Prompt string
	// Gate admits the model send. It runs before the provider call and fails
	// the turn when the daemon refuses.
	Gate func() error
	// OnEvent receives the kernel's events.
	OnEvent func(event string)
}

// TurnResult is what one turn produced.
type TurnResult struct {
	ConversationId int64    `json:"conversationId"`
	SubmissionId   int64    `json:"submissionId"`
	Status         string   `json:"status"`
	Text           string   `json:"text"`
	StopReason     string   `json:"stopReason"`
	ToolCalls      []string `json:"toolCalls"`
	Tools          []string `json:"tools"`
	Entries        int      `json:"entries"`
}

// identitiesDoc maps a Graph identity to its durable conversation.
//
// The mapping is a durable document, so the identity of a session survives the
// restart of the daemon and the kernel can find the very same transcript again.
//
// The document's shape is the one the TypeScript kernel wrote: the identities
// live under `conversations`. Both kernels therefore address the same document
// and find the same conversation, so a database the old kernel wrote keeps its
// history when the new kernel takes it over.
var identitiesDoc = durable.DefineDoc[map[string]any](durable.DocDefinition[map[string]any]{
	CommonDocDefinition: durable.CommonDocDefinition[map[string]any]{
		Kind:    "graph.identities",
		Version: 1,
		Initial: func() map[string]any { return map[string]any{"conversations": map[string]any{}} },
	},
	DocumentSemantics: durable.DocumentSemantics{Scope: durable.ScopeSession},
})

// RunTurn runs one agent turn on the kernel and persists everything it did.
func RunTurn(ctx context.Context, options TurnOptions) (TurnResult, error) {
	registry := harness.CreateRegistry()
	models, model := buildModels(options.Model)
	kernel, err := Open(ctx, Options{Database: options.Database, Models: models, Registry: registry})
	if err != nil {
		return TurnResult{}, err
	}
	defer func() { _ = kernel.Close() }()

	recorder := &callRecorder{}
	registrations := toolRegistrations(options.Tools, recorder)
	// The MCP servers are connected by the kernel itself: the model reaches
	// their tools directly, without a gateway tool and without an extension.
	mcpConnections, mcpTools, err := connectMcpServers(ctx, options.McpServers, recorder)
	if err != nil {
		return TurnResult{}, err
	}
	defer closeMcpServers(mcpConnections)
	registrations = append(registrations, mcpTools...)

	// The extension is installed under the name the identity owns, the same
	// name the resident session path uses. Two derivations of one name would
	// let the last writer replace the tool bodies the other conversation's
	// durable selection still points at.
	extension := &durable.Extension{Name: extensionName(options.Identity), Tools: registrations}
	if err := registry.Install(extension); err != nil {
		return TurnResult{}, err
	}

	// The model is offered the tools it may call, and the tools may call the
	// same ones. PiG keeps the two lists apart: a tool that is only callable
	// is never offered to the model.
	conversation, err := conversationFor(ctx, kernel, options.Identity, harness.AgentChange{
		Model:        harness.SetTo(durable.ModelRef{Provider: model.ProviderMeta.ProviderID, ModelId: model.ID}),
		Instructions: harness.SetTo(options.Instructions),
		Tools:        harness.SetTo(harness.ToolChange{List: registrations}),
		ModelTools:   harness.SetTo(harness.ToolChange{List: registrations}),
		Extensions:   harness.SetTo(harness.ExtensionChange{List: []*durable.Extension{extension}}),
	})
	if err != nil {
		return TurnResult{}, err
	}

	// The host admits the turn before anything is sent.
	if options.Gate != nil {
		if err := options.Gate(); err != nil {
			return TurnResult{}, err
		}
	}
	// The request id deduplicates an admission: the same input must not be
	// admitted twice, and a second, different input needs its own id.
	requestId := options.Identity + ":turn:" + newRequestId()
	submission, err := conversation.Submit(ctx, durable.SubmissionDraft{
		Type:      durable.SubmissionTypeInput,
		Content:   ai.UserText(options.Prompt),
		RequestId: &requestId,
		WhenBusy:  durable.WhenBusyReject,
	})
	if err != nil {
		return TurnResult{}, err
	}
	settled, err := submission.Wait(ctx)
	if err != nil {
		return TurnResult{}, err
	}
	called := recorder.calls()
	offered := []string{}
	for _, registration := range registrations {
		offered = append(offered, registration.ToolSchema.Name)
	}
	result := TurnResult{
		ConversationId: int64(conversation.Id()),
		SubmissionId:   int64(settled.Id),
		Status:         string(settled.Status),
		ToolCalls:      called,
		Tools:          offered,
	}
	if settled.Answer != nil {
		text, stopReason, _, _, err := answerText(ctx, conversation, *settled.Answer)
		if err != nil {
			return TurnResult{}, err
		}
		result.Text = text
		result.StopReason = stopReason
	}
	entries, err := conversation.Entries(ctx, durable.EntryQuery{ConversationId: conversation.Id()}, 1000, nil)
	if err != nil {
		return TurnResult{}, err
	}
	result.Entries = len(entries.Items)
	return result, nil
}

// conversationFor finds the durable conversation of one identity, creating and
// configuring it the first time the identity is seen.
func conversationFor(ctx context.Context, kernel *Kernel, identity string, change harness.AgentChange) (harness.Conversation, error) {
	root, err := kernel.Harness().Root(ctx, nil)
	if err != nil {
		return nil, err
	}
	var conversationId durable.ConversationId
	_, err = root.Commit(ctx, func(tx durable.Tx) (any, error) {
		draft, err := durable.TxDoc[map[string]any](tx, identitiesDoc)
		if err != nil {
			return nil, err
		}
		conversations := draft.Object("conversations")
		if conversations == nil {
			if err := draft.Set("conversations", map[string]any{}); err != nil {
				return nil, err
			}
			conversations = draft.Object("conversations")
		}
		if conversations == nil {
			return nil, fmt.Errorf("pig kernel: the identity document has no conversation index")
		}
		if value, found := conversations.Lookup(identity); found {
			if id, ok := conversationNumber(value); ok {
				conversationId = durable.ConversationId(id)
				return nil, nil
			}
		}
		created, err := tx.CreateConversation(durable.CreateConversationOptions{
			Ownership: durable.ConversationOwnership{Kind: durable.ConversationOwnerless},
		})
		if err != nil {
			return nil, err
		}
		if err := harness.Configure(tx, created.Id, change); err != nil {
			return nil, err
		}
		conversationId = created.Id
		return nil, conversations.Set(identity, int64(created.Id))
	})
	if err != nil {
		return nil, err
	}
	conversation, err := kernel.Harness().Conversation(ctx, conversationId)
	if err != nil {
		return nil, err
	}
	if conversation == nil {
		return nil, fmt.Errorf("pig kernel: the durable conversation %d is missing", conversationId)
	}
	// The agent is configured on every open: a reopened session may run on
	// another model, with other tools or other instructions.
	if err := conversation.Configure(ctx, change); err != nil {
		return nil, err
	}
	return conversation, nil
}

// answerText reads the assistant answer of a settled submission.
func answerText(ctx context.Context, conversation harness.Conversation, answer durable.EntryId) (string, string, *Usage, bool, error) {
	var text string
	var stopReason string
	var usage *Usage
	answered := false
	_, err := conversation.Commit(ctx, func(tx durable.Tx) (any, error) {
		entry, err := tx.Entry(answer)
		if err != nil {
			return nil, err
		}
		if entry == nil {
			return nil, fmt.Errorf("pig kernel: the answered entry %d is missing", answer)
		}
		for _, message := range entry.Model {
			assistant, ok := message.(ai.AssistantMessage)
			if !ok {
				continue
			}
			// An answer with no content is an answer that says nothing: the
			// turn happened, but it produced no work for the caller to read.
			if len(assistant.Content) > 0 {
				answered = true
			}
			stopReason = string(assistant.StopReason)
			if reported := assistant.Usage; reported.TotalTokens > 0 || reported.Input > 0 || reported.Output > 0 {
				usage = &Usage{
					Input: reported.Input, Output: reported.Output,
					CacheRead: reported.CacheRead, CacheWrite: reported.CacheWrite,
					Total: reported.TotalTokens,
				}
			}
			parts := []string{}
			for _, block := range assistant.Content {
				if content, ok := block.(ai.TextContent); ok {
					parts = append(parts, content.Text)
				}
			}
			text = parts[len(parts)-1]
		}
		return nil, nil
	})
	if err != nil {
		return "", "", nil, false, err
	}
	return text, stopReason, usage, answered, nil
}

// toolRegistrations turns the tools one session may call into the
// registrations the kernel offers.
//
// The tool bodies are the daemon's: the kernel carries the call and the
// result, and the daemon decides whether the call is allowed and what it
// does.
func toolRegistrations(tools []ToolSpec, recorder *callRecorder) []*durable.ToolRegistration {
	registrations := make([]*durable.ToolRegistration, 0, len(tools))
	for _, tool := range tools {
		spec := tool
		registrations = append(registrations, &durable.ToolRegistration{
			ToolSchema: ai.ToolSchema{
				Name:        spec.Name,
				Description: spec.Description,
				Parameters:  spec.Parameters,
			},
			Execute: func(ctx context.Context, args any, _ durable.ToolExecutionApi) (durable.ToolExecutionResult, error) {
				recorder.record(spec.Name)
				decoded := map[string]any{}
				if body, err := json.Marshal(args); err == nil {
					_ = json.Unmarshal(body, &decoded)
				}
				if spec.Result != nil {
					value, err := spec.Result(ctx, decoded)
					if err != nil {
						return durable.ToolExecutionResult{
							Output:  []ai.ToolResultMessageContent{ai.TextContent{Text: "Tool failed: " + err.Error()}},
							IsError: boolPointer(true),
						}, nil
					}
					return toolExecutionResult(value), nil
				}
				text, err := spec.Execute(ctx, decoded)
				if err != nil {
					return durable.ToolExecutionResult{
						Output:  []ai.ToolResultMessageContent{ai.TextContent{Text: "Tool failed: " + err.Error()}},
						IsError: boolPointer(true),
					}, nil
				}
				return durable.ToolExecutionResult{Output: []ai.ToolResultMessageContent{ai.TextContent{Text: text}}}, nil
			},
		})
	}
	return registrations
}

// toolExecutionResult reads the SDK's own tool result.
//
// The daemon's tools answer with the SDK's tool result shape: the content
// blocks the model reads and the details the console shows. The kernel stores
// exactly that, so nothing of the answer is lost on the way.
func toolExecutionResult(value any) durable.ToolExecutionResult {
	result := durable.ToolExecutionResult{}
	if value == nil {
		return result
	}
	body, err := json.Marshal(value)
	if err != nil {
		return result
	}
	message := &ai.ToolResultMessage{}
	if err := json.Unmarshal(body, message); err != nil {
		return result
	}
	result.Output = message.Content
	if message.Details != nil {
		result.Details = message.Details
		result.HasDetails = true
	}
	return result
}

// buildModels registers the turn's model with PiG's model runtime.
//
// The provider is the Graph provider: the base URL, the key and the headers
// are the daemon's, and PiG speaks the provider protocol.
func buildModels(spec ModelSpec) (durable.Models, *ai.Model) {
	api := ai.API(spec.API)
	if api == "" {
		api = ai.APIOpenAICompletions
	}
	model := &ai.Model{
		ID:          spec.Id,
		DisplayName: spec.Name,
		Input:       []ai.ModelInputModality{"text"},
		Capabilities: ai.ModelCapabilities{
			ContextWindow:   spec.ContextWindow,
			MaxOutputTokens: spec.MaxTokens,
			SupportsToolUse: true,
		},
		ProviderMeta: ai.ProviderMetadata{ProviderID: spec.ProviderID, API: api, BaseURL: spec.BaseURL},
	}
	headers := ai.ProviderHeaders{}
	for name, value := range spec.Headers {
		header := value
		headers[name] = &header
	}
	provider := ai.CreateProvider(ai.CreateProviderOptions{
		ID:      spec.ProviderID,
		BaseURL: spec.BaseURL,
		Headers: headers,
		Auth: ai.ProviderAuth{APIKey: &ai.APIKeyAuth{
			Name: "Graph",
			Resolve: func(context.Context, ai.APIKeyAuthInput) (*ai.AuthResult, error) {
				return &ai.AuthResult{Auth: ai.ModelAuth{APIKey: spec.APIKey, Headers: headers, BaseURL: spec.BaseURL}}, nil
			},
		}},
		Models: ai.AnyModels([]*ai.Model{model}),
		API:    ai.OpenAICompletionsAPI(),
	})
	models := ai.CreateModels()
	models.SetProvider(provider)
	return models, model
}

func boolPointer(value bool) *bool { return &value }

// callRecorder records the tools a turn called. The harness runs tools on its
// own goroutines, so the record is guarded.
type callRecorder struct {
	mutex sync.Mutex
	names []string
}

func (recorder *callRecorder) record(name string) {
	recorder.mutex.Lock()
	defer recorder.mutex.Unlock()
	recorder.names = append(recorder.names, name)
}

func (recorder *callRecorder) calls() []string {
	recorder.mutex.Lock()
	defer recorder.mutex.Unlock()
	return append([]string{}, recorder.names...)
}

// newRequestId is one unique admission id.
func newRequestId() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

// conversationNumber reads a durable conversation identifier out of a document
// value, which JSON stores as a number.
func conversationNumber(value any) (int64, bool) {
	switch number := value.(type) {
	case int64:
		return number, true
	case float64:
		return int64(number), true
	case int:
		return int64(number), true
	}
	return 0, false
}
