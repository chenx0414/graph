package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"context"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

const (
	AgentKernelPig = "pig"
)

func CreatePigAgentSessionTransport(store *TaskStore, codemode CodemodeSettings) AgentSessionTransport {
	return &pigAgentTransport{store: store, codemode: codemode}
}

type pigAgentTransport struct {
	store    *TaskStore
	codemode CodemodeSettings
}

func (transport *pigAgentTransport) Open(request AgentSessionRequest) (AgentSession, error) {
	tools := pigToolSpecs(transport.store, request)
	extensions, err := pigExtensionSpecs(context.Background(), request, request.Broker, func(tool string, ms float64, isError bool) {
		transport.store.RecordToolCall(ToolCallInput{InstanceID: request.Binding.InstanceId, Tool: tool, Ms: ms, IsError: isError})
	})
	if err != nil {
		return nil, err
	}
	tools = append(tools, extensions...)
	session, err := openPigSession(context.Background(), transport.store.Path, request, transport.codemode, pigProviderBridge(request.Stream, request.Model, func(kernelOptions map[string]any) map[string]any {
		effective := map[string]any{}
		for key, value := range pigProviderOptions(request) {
			effective[key] = value
		}
		for key, value := range kernelOptions {
			effective[key] = value
		}
		return effective
	}), tools, request.OnEvent, nil)
	if err != nil {
		return nil, err
	}
	if !request.Recovering {
		if err := pigkernel.WaitConversationIdle(context.Background(), transport.store.Path, pigSessionIdentity(request)); err != nil {
			_ = session.Close()
			return nil, err
		}
	}
	if err := transport.freeze(request); err != nil {
		_ = session.Close()
		return nil, err
	}
	return &pigAgentSession{session: session, request: request}, nil
}

func (transport *pigAgentTransport) freeze(request AgentSessionRequest) error {
	if request.ExecutionId == "" || request.Binding.InstanceId == "" {
		return nil
	}
	preAdmission := []string{}
	for _, call := range kernelRows(transport.store.Db, "SELECT id FROM invocations WHERE operation_id=? AND usage IS NOT NULL", request.ExecutionId) {
		preAdmission = append(preAdmission, kernelString(call["id"]))
	}
	record := pigFrozenExecution(request, preAdmission)
	return pigkernel.FreezeExecution(context.Background(), transport.store.Path, request.Binding.InstanceId, record)
}

func openPigSession(ctx context.Context, database string, request AgentSessionRequest, codemode CodemodeSettings, provider pigkernel.ProviderBridge, tools []pigkernel.ToolSpec, onEvent func(map[string]any), onToolCall func(pigkernel.ToolCallRecord)) (*pigkernel.Session, error) {
	tools, provider, err := pigDeferredToolSurface(request, tools, provider)
	if err != nil {
		return nil, err
	}
	options := pigkernel.SessionOptions{
		Database:     database,
		Identity:     pigSessionIdentity(request),
		Model:        pigModelSpec(request.Model),
		Provider:     provider,
		Tools:        tools,
		Codemode:     pigCodemodeOptions(codemode),
		McpServers:   pigMcpServers(request),
		Instructions: pigSessionInstructions(request),
		RequestId:    request.InputRequestId,
		OnEvent:      onEvent,
		OnToolCall:   onToolCall,
		ToolResults:  toolResultRenderer(request.Binding.InstanceId, request.StateDir),
	}
	if request.ThinkingLevel != nil {
		options.ThinkingLevel = *request.ThinkingLevel
	}
	if request.Compaction != nil {
		options.Compaction = &pigkernel.CompactionThresholds{
			ReserveTokens:    request.Compaction.ReserveTokens,
			KeepRecentTokens: request.Compaction.KeepRecentTokens,
		}
		if ceiling := compactionContextCeiling(); ceiling > 0 && ceiling < options.Compaction.KeepRecentTokens {
			options.Compaction.KeepRecentTokens = max(1, ceiling/2)
		}
	}
	return pigkernel.OpenSession(ctx, options)
}

func pigProviderBridge(stream PromptStreamFunc, model any, options func(map[string]any) map[string]any) pigkernel.ProviderBridge {
	return pigkernel.ProviderBridge{
		Stream: func(ctx context.Context, transcript []map[string]any, kernelOptions map[string]any) (pigkernel.EventStream, error) {
			messages := make([]any, 0, len(transcript))
			for _, message := range transcript {
				messages = append(messages, message)
			}
			context := map[string]any{"messages": messages}
			effective := kernelOptions
			if options != nil {
				effective = options(kernelOptions)
			}
			if ctx != nil {
				if effective == nil {
					effective = map[string]any{}
				}
				effective["abort"] = ctx.Done()
			}
			return stream(model, context, effective)
		},
	}
}

func pigToolSpecs(store *TaskStore, request AgentSessionRequest) []pigkernel.ToolSpec {
	specs := []pigkernel.ToolSpec{}
	for _, tool := range request.Tools {
		definition := tool
		gated := piWorkerGatedTool(definition, request.Broker)
		specs = append(specs, pigkernel.ToolSpec{
			Name:        definition.Name,
			Description: definition.Description,
			Parameters:  asMap(definition.Parameters),
			Result: func(ctx context.Context, args map[string]any) (result any, err error) {
				defer func() {
					recovered := recover()
					if recovered == nil {
						return
					}
					switch failure := recovered.(type) {
					case *RuntimeError:
						result, err = nil, failure
					case error:
						result, err = nil, failure
					default:
						err = errors.New(fmt.Sprint(recovered))
					}
				}()
				prepared := any(args)
				if definition.PrepareArguments != nil {
					prepared = definition.PrepareArguments(prepared)
				}
				params, _ := prepared.(map[string]any)
				if params == nil {
					params = map[string]any{}
				}
				started := time.Now()
				if deferredToolWantsBackground(definition, params) {
					receipt, failure := admitDeferredCall(store, request, definition, params)
					if failure != nil {
						recordPigToolCall(request, definition.Name, started, true)
						return nil, failure
					}
					recordPigToolCall(request, definition.Name, started, false)
					return receipt, nil
				}
				value := gated(graphUUID(), params, ctx)
				if failure, ok := value.(error); ok {
					recordPigToolCall(request, definition.Name, started, true)
					return nil, failure
				}
				recordPigToolCall(request, definition.Name, started, false)
				return value, nil
			},
		})
	}
	return specs
}

func pigCodemodeOptions(codemode CodemodeSettings) *pigkernel.CodemodeOptions {
	if !codemode.Enabled {
		return nil
	}
	return &pigkernel.CodemodeOptions{CacheDir: codemode.CacheDir, TimeoutMs: float64(codemode.TimeoutMs)}
}

func pigProviderOptions(request AgentSessionRequest) map[string]any {
	if request.ThinkingLevel == nil || *request.ThinkingLevel == "" {
		return nil
	}
	return map[string]any{"reasoning": *request.ThinkingLevel}
}

func recordPigToolCall(request AgentSessionRequest, tool string, started time.Time, failed bool) {
	if request.OnToolCall == nil {
		return
	}
	defer func() { _ = recover() }()
	request.OnToolCall(PiAdapterToolCall{Tool: tool, Ms: float64(time.Since(started).Milliseconds()), IsError: failed})
}

func pigMcpServers(request AgentSessionRequest) []pigkernel.McpServerSpec {
	servers := []pigkernel.McpServerSpec{}
	for _, server := range request.McpServers {
		definition, _ := server.Definition.(*McpServerDefinition)
		servers = append(servers, McpServerSpecFrom(server.Name, definition))
	}
	return servers
}

func pigModelSpec(model any) pigkernel.ModelSpec {
	spec := pigkernel.ModelSpec{}
	if view, ok := model.(piModelView); ok {
		spec.ProviderID = view.Provider
		spec.Id = view.Id
		spec.Name = view.Name
		spec.API = string(view.Api)
		spec.BaseURL = view.BaseUrl
		spec.ContextWindow = view.ContextWindow
		spec.MaxTokens = view.MaxTokens
		spec.Reasoning = view.Reasoning
		spec.Input = modelInputNames(view.Input)
		return spec
	}
	record := asMap(model)
	if record == nil {
		return spec
	}
	spec.ProviderID = mapString(record, "provider")
	spec.Id = mapString(record, "id")
	spec.Name = mapString(record, "name")
	spec.API = mapString(record, "api")
	spec.BaseURL = mapString(record, "baseUrl")
	spec.ContextWindow = int(asFloatValue(record["contextWindow"]))
	spec.MaxTokens = int(asFloatValue(record["maxTokens"]))
	spec.Reasoning = true
	return spec
}

type pigAgentSession struct {
	session *pigkernel.Session
	request AgentSessionRequest
	mutex   sync.Mutex
	inspect AgentSessionInspect
}

func pigUserContent(text string, images []ImageContent) ai.UserContent {
	if len(images) == 0 {
		return ai.UserText(text)
	}
	blocks := ai.UserContentBlocks{ai.TextContent{Text: text}}
	for _, image := range images {
		if image.Data == "" {
			continue
		}
		blocks = append(blocks, ai.ImageContent{Data: image.Data, MimeType: image.MimeType})
	}
	return blocks
}

func (session *pigAgentSession) Prompt(text string, images []ImageContent) (AgentSessionTurn, error) {
	budget := pigSessionContextBudget(session.request)
	compactAt := pigSessionCompactionTrigger(session.request)
	if reset, _, estimated, err := session.session.PrepareContext(context.Background(), budget, compactAt, text, COMPACTION_INSTRUCTIONS, ""); err != nil {
		return AgentSessionTurn{}, err
	} else if reset {
		session.emitContextReset(estimated, budget)
	}
	turn, err := session.session.PromptContent(context.Background(), pigUserContent(text, images))
	if err != nil {
		return AgentSessionTurn{}, err
	}
	result := AgentSessionTurn{
		Inspect:            session.Inspect(),
		FinalAssistantText: turn.Text,
	}
	if turn.StopReason != "" {
		result.StopReason = stringPointer(turn.StopReason)
	}
	if turn.ErrorMessage != "" {
		result.ErrorMessage = stringPointer(turn.ErrorMessage)
	}
	if turn.Usage != nil {
		result.Usage = &AgentSessionUsage{
			Input: turn.Usage.Input, Output: turn.Usage.Output,
			CacheRead: turn.Usage.CacheRead, CacheWrite: turn.Usage.CacheWrite,
			Total: turn.Usage.Total,
		}
	}
	return result, nil
}

func pigSessionCompactionTrigger(request AgentSessionRequest) int {
	window := pigModelSpec(request.Model).ContextWindow
	if window <= 0 {
		return 0
	}
	trigger := window * 70 / 100
	if ceiling := compactionContextCeiling(); ceiling > 0 && ceiling < trigger {
		trigger = ceiling
	}
	if trigger < 1 {
		return 1
	}
	return trigger
}

func pigSessionContextBudget(request AgentSessionRequest) int {
	window := pigModelSpec(request.Model).ContextWindow
	if window <= 0 {
		return 0
	}
	tools, _ := json.Marshal(request.Tools)
	overhead := len(request.SystemPrompt)/4 + len(tools)/4
	if overhead < 4096 {
		overhead = 4096
	}
	budget := window - overhead
	if budget < 1 {
		return 1
	}
	return budget
}

func (session *pigAgentSession) emitContextReset(estimated, budget int) {
	if session.request.OnEvent == nil {
		return
	}
	session.request.OnEvent(map[string]any{"type": "context_reset", "estimatedTokens": estimated, "contextWindow": budget})
}

func (session *pigAgentSession) Compact(instructions string) error {
	return session.session.Compact(context.Background(), instructions)
}

func (session *pigAgentSession) Steer(text string) error {
	return session.session.Steer(context.Background(), text)
}

func (session *pigAgentSession) Interrupt(text *string) error {
	return session.session.Interrupt(context.Background(), text)
}

func (session *pigAgentSession) Stop() error {
	return session.session.Stop(context.Background())
}

func (session *pigAgentSession) Inspect() AgentSessionInspect {
	view := session.session.Inspect()
	session.mutex.Lock()
	defer session.mutex.Unlock()
	session.inspect = AgentSessionInspect{
		Binding:          session.request.Binding,
		SessionId:        view.SessionId,
		SessionFile:      view.SessionFile,
		ActiveTools:      view.ActiveTools,
		RegisteredTools:  view.RegisteredTools,
		LoadedExtensions: view.LoadedExtensions,
		ExtensionErrors:  []AgentSessionExtensionError{},
		Messages:         view.Messages,
	}
	if session.request.BundleDigest != "" {
		session.inspect.BundleDigest = stringPointer(session.request.BundleDigest)
	}
	if session.request.ToolPolicyDigest != "" {
		session.inspect.ToolPolicyDigest = stringPointer(session.request.ToolPolicyDigest)
	}
	if session.request.RuntimePolicyDigest != "" {
		session.inspect.RuntimePolicyDigest = stringPointer(session.request.RuntimePolicyDigest)
	}
	if view.Model != "" {
		session.inspect.Model = stringPointer(view.Model)
	}
	return session.inspect
}

func (session *pigAgentSession) Close() error {
	return session.session.Close()
}

func pigSessionIdentity(request AgentSessionRequest) string {
	identity := ""
	if request.Binding.InstanceId != "" {
		identity = request.Binding.InstanceId
	} else {
		identity = fmt.Sprintf("execution-%s", request.ExecutionId)
	}
	if request.IsolatedContext {
		return identity + ":review"
	}
	return identity
}

func pigSessionJson(session AgentSession) ([]byte, error) {
	return json.Marshal(session.Inspect())
}
