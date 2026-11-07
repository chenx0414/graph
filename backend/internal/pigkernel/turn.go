package pigkernel

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)


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
	Input         []string
	ThinkingLevel string
}

type ToolResultRenderer func(name string, args map[string]any, value any) any

type ToolSpec struct {
	Name        string
	Description string
	Parameters  map[string]any
	Execute func(ctx context.Context, args map[string]any) (string, error)
	Result func(ctx context.Context, args map[string]any) (any, error)
}

type TurnOptions struct {
	Database string
	Identity string
	Model ModelSpec
	Tools []ToolSpec
	McpServers []McpServerSpec
	Instructions string
	Prompt string
	OnEvent func(event string)
	ToolResults ToolResultRenderer
}

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

var identitiesDoc = durable.DefineDoc[map[string]any](durable.DocDefinition[map[string]any]{
	CommonDocDefinition: durable.CommonDocDefinition[map[string]any]{
		Kind:    "graph.identities",
		Version: 1,
		Initial: func() map[string]any { return map[string]any{"conversations": map[string]any{}} },
		CheckpointWhen: func(map[string]any, []durable.Op, durable.CheckpointInfo) bool { return true },
	},
	DocumentSemantics: durable.DocumentSemantics{Scope: durable.ScopeSession},
})

func RunTurn(ctx context.Context, options TurnOptions) (TurnResult, error) {
	registry := harness.CreateRegistry()
	models, model := buildModels(options.Model)
	kernel, err := Open(ctx, Options{Database: options.Database, Models: models, Registry: registry})
	if err != nil {
		return TurnResult{}, err
	}
	defer func() { _ = kernel.Close() }()

	recorder := &callRecorder{}
	registrations := toolRegistrations(options.Tools, recorder, options.ToolResults)
	mcpConnections, mcpTools, err := connectMcpServers(ctx, options.McpServers, recorder)
	if err != nil {
		return TurnResult{}, err
	}
	defer closeMcpServers(mcpConnections)
	registrations = append(registrations, mcpTools...)

	extension := &durable.Extension{Name: extensionName(options.Identity), Tools: registrations}
	if err := registry.Install(extension); err != nil {
		return TurnResult{}, err
	}

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
		text, stopReason, _, err := answerText(ctx, conversation, *settled.Answer)
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
	if err := conversation.Configure(ctx, change); err != nil {
		return nil, err
	}
	return conversation, nil
}

func answerText(ctx context.Context, conversation harness.Conversation, answer durable.EntryId) (string, string, *Usage, error) {
	var text string
	var stopReason string
	var usage *Usage
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
			text = strings.Join(parts, "")
		}
		return nil, nil
	})
	if err != nil {
		return "", "", nil, err
	}
	return text, stopReason, usage, nil
}

func toolRegistrations(tools []ToolSpec, recorder *callRecorder, renderer ToolResultRenderer) []*durable.ToolRegistration {
	registrations := make([]*durable.ToolRegistration, 0, len(tools))
	for _, tool := range tools {
		spec := tool
		registrations = append(registrations, &durable.ToolRegistration{
			ToolSchema: ai.ToolSchema{
				Name:        spec.Name,
				Description: spec.Description,
				Parameters:  spec.Parameters,
			},
			OutputLimits: toolOutputLimits(renderer),
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
					terminate := false
					if result, ok := value.(map[string]any); ok {
						terminate, _ = result["terminate"].(bool)
					}
					if renderer != nil {
						value = renderer(spec.Name, decoded, value)
					}
					result := toolExecutionResult(value)
					if terminate {
						result.Control = &durable.ToolControl{Terminate: true}
					}
					return result, nil
				}
				text, err := spec.Execute(ctx, decoded)
				if err != nil {
					return durable.ToolExecutionResult{
						Output:  []ai.ToolResultMessageContent{ai.TextContent{Text: "Tool failed: " + err.Error()}},
						IsError: boolPointer(true),
					}, nil
				}
				value := any(map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}})
				if renderer != nil {
					value = renderer(spec.Name, decoded, value)
				}
				return toolExecutionResult(value), nil
			},
		})
	}
	return registrations
}

func toolOutputLimits(renderer ToolResultRenderer) *durable.ToolOutputLimits {
	if renderer == nil {
		return nil
	}
	unlimited := int(^uint(0) >> 1)
	return &durable.ToolOutputLimits{MaxBytes: &unlimited, MaxLines: &unlimited}
}

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

func pigModelInputs(values []string) []ai.ModelInputModality {
	inputs := []ai.ModelInputModality{}
	seen := map[string]bool{}
	for _, value := range values {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "text":
			if !seen["text"] {
				inputs = append(inputs, ai.ModelInputModality("text"))
				seen["text"] = true
			}
		case "image":
			if !seen["image"] {
				inputs = append(inputs, ai.ModelInputModality("image"))
				seen["image"] = true
			}
		}
	}
	if len(inputs) == 0 {
		return []ai.ModelInputModality{"text"}
	}
	return inputs
}

func buildModels(spec ModelSpec) (durable.Models, *ai.Model) {
	api := ai.API(spec.API)
	if api == "" {
		api = ai.APIOpenAICompletions
	}
	model := &ai.Model{
		ID:          spec.Id,
		DisplayName: spec.Name,
		Input:       pigModelInputs(spec.Input),
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

func newRequestId() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

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
