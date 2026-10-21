package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// The PiG kernel is the Agent kernel of the daemon.
//
// The division of labour is the one the daemon already kept. The daemon owns
// the model channel, the tool bodies, the admission gate, the budget and the
// credential; the kernel owns the execution history: the transcript, the
// admissions, the tool calls and their results.
//
// The MCP servers are connected by the kernel itself. The model reaches their
// tools under PiG's own `mcp__<server>__<tool>` names, so no gateway tool and
// no adapter extension stand between the model and the server.

// The Agent kernels the daemon can run on.
//
// The PiG kernel is the default: it carries the Agent sessions, the crash
// recovery and the graph node lane inside this process. The TypeScript
// sidecar is still reachable by name (`--kernel node`) while it is being
// retired.
const (
	// AgentKernelNode runs the Agent sessions in the TypeScript durable sidecar.
	AgentKernelNode = "node"
	// AgentKernelPig runs the Agent sessions in the Go PiG kernel.
	AgentKernelPig = "pig"
)

// agentKernel is the kernel this process runs on.
//
// It is read by the paths that must not open the TypeScript sidecar while the
// PiG kernel owns the durable namespace.
var agentKernel = struct {
	sync.RWMutex
	value string
}{value: AgentKernelPig}

// SetAgentKernel records the kernel this process runs on.
func SetAgentKernel(kernel string) {
	agentKernel.Lock()
	defer agentKernel.Unlock()
	if kernel == "" {
		kernel = AgentKernelPig
	}
	agentKernel.value = kernel
}

// agentKernelMode is the kernel this process runs on.
func agentKernelMode() string {
	agentKernel.RLock()
	defer agentKernel.RUnlock()
	return agentKernel.value
}

// CreatePigAgentSessionTransport opens Agent sessions on the PiG kernel.
func CreatePigAgentSessionTransport(store *TaskStore, codemode CodemodeSettings) AgentSessionTransport {
	return &pigAgentTransport{store: store, codemode: codemode}
}

type pigAgentTransport struct {
	store    *TaskStore
	codemode CodemodeSettings
}

// Open opens one session on the PiG kernel.
func (transport *pigAgentTransport) Open(request AgentSessionRequest) (AgentSession, error) {
	options := pigkernel.SessionOptions{
		Database:     transport.store.Path,
		Identity:     request.Binding.InstanceId,
		Model:        pigModelSpec(request.Model),
		Provider:     pigProviderBridge(request),
		Tools:        pigToolSpecs(request, transport.codemode),
		McpServers:   pigMcpServers(request),
		Instructions: pigSessionInstructions(request),
		RequestId:    request.InputRequestId,
		OnEvent:      request.OnEvent,
	}
	if request.ThinkingLevel != nil {
		options.ThinkingLevel = *request.ThinkingLevel
	}
	session, err := pigkernel.OpenSession(context.Background(), options)
	if err != nil {
		return nil, err
	}
	// The execution is frozen before the turn starts. The record is what the
	// recovery reads when the daemon dies mid-turn: which execution the
	// kernel was running, the model it was admitted with and the input it was
	// waiting for. The durable conversation exists by now, so the record has
	// a place to live.
	if err := transport.freeze(request); err != nil {
		_ = session.Close()
		return nil, err
	}
	return &pigAgentSession{session: session, request: request}, nil
}

// freeze stores the frozen record of one execution.
//
// The invocations that existed before the execution are named in the record:
// an invocation beyond them is a provider call this execution made, and the
// turn must not be replayed.
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

// pigProviderBridge is the daemon's model channel, seen from the kernel.
//
// The kernel asks for the answer; the daemon's own stream produces it. The
// daemon's stream is the one that admits the send, spends the credential,
// records the usage and refuses a request the budget does not allow, so the
// kernel never opens a provider channel of its own.
func pigProviderBridge(request AgentSessionRequest) pigkernel.ProviderBridge {
	return pigkernel.ProviderBridge{
		Stream: func(_ context.Context, transcript []map[string]any, options map[string]any) (pigkernel.EventStream, error) {
			messages := make([]any, 0, len(transcript))
			for _, message := range transcript {
				messages = append(messages, message)
			}
			context := map[string]any{"messages": messages}
			return request.Stream(request.Model, context, options)
		},
	}
}

// pigToolSpecs are the Graph tools one session may call.
//
// The tool bodies are the daemon's, and so is the admission gate: every call
// passes the same gate a model send passes.
func pigToolSpecs(request AgentSessionRequest, codemode CodemodeSettings) []pigkernel.ToolSpec {
	specs := []pigkernel.ToolSpec{}
	for _, tool := range request.Tools {
		definition := tool
		gated := piWorkerGatedTool(definition, request.Broker)
		specs = append(specs, pigkernel.ToolSpec{
			Name:        definition.Name,
			Description: definition.Description,
			Parameters:  asMap(definition.Parameters),
			Result: func(ctx context.Context, args map[string]any) (any, error) {
				prepared := any(args)
				if definition.PrepareArguments != nil {
					prepared = definition.PrepareArguments(prepared)
				}
				params, _ := prepared.(map[string]any)
				if params == nil {
					params = map[string]any{}
				}
				started := time.Now()
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
	if codemode.Enabled {
		specs = append(specs, pigCodemodeSpec(request.Tools, request.Broker, codemode))
	}
	return specs
}

// pigCodemodeSpec is the codemode tool one session may call.
//
// The sandbox's host table is the session's own tools, so a script reaches
// exactly the tools the model could have called directly - and every one of
// them passes the same gate.
func pigCodemodeSpec(tools []ToolDefinition, broker SendGate, settings CodemodeSettings) pigkernel.ToolSpec {
	tool := CodemodeTool(tools, broker, settings)
	return pigkernel.ToolSpec{
		Name:        tool.Name,
		Description: tool.Description,
		Parameters:  asMap(tool.Parameters),
		Result: func(_ context.Context, args map[string]any) (any, error) {
			value, err := tool.Execute(graphUUID(), args)
			if err != nil {
				return nil, err
			}
			return value, nil
		},
	}
}

// recordPigToolCall reports one tool call to the daemon's telemetry.
func recordPigToolCall(request AgentSessionRequest, tool string, started time.Time, failed bool) {
	if request.OnToolCall == nil {
		return
	}
	defer func() { _ = recover() }()
	request.OnToolCall(PiAdapterToolCall{Tool: tool, Ms: float64(time.Since(started).Milliseconds()), IsError: failed})
}

// pigMcpServers are the MCP servers the kernel connects natively.
//
// The declaration is the one the Graph already builds: which servers a
// session may use and which secrets they get does not change. Only the
// transport does: the kernel connects the server itself.
func pigMcpServers(request AgentSessionRequest) []pigkernel.McpServerSpec {
	servers := []pigkernel.McpServerSpec{}
	for _, server := range request.McpAdapterServers {
		definition, _ := server.Definition.(*McpAdapterServerDefinition)
		servers = append(servers, McpServerSpecFrom(server.Name, definition))
	}
	return servers
}

// pigModelSpec is the model one session sends to.
//
// The model is the daemon's: its identity, its protocol and its window come
// from the Graph configuration. The credential never reaches the kernel - the
// daemon's own stream spends it.
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
		return spec
	}
	// A restored session carries the frozen model as a record, not as a view.
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

// pigAgentSession is one live session on the PiG kernel.
type pigAgentSession struct {
	session *pigkernel.Session
	request AgentSessionRequest
	mutex   sync.Mutex
	inspect AgentSessionInspect
}

// Prompt sends one prompt and returns the turn it produced.
func (session *pigAgentSession) Prompt(text string, images []ImageContent) (AgentSessionTurn, error) {
	turn, err := session.session.Prompt(context.Background(), text)
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

// Compact prepares the next operation's prompt.
func (session *pigAgentSession) Compact(instructions string) error {
	return session.session.Compact(context.Background(), instructions)
}

// Steer injects a message into the running turn.
func (session *pigAgentSession) Steer(text string) error {
	return session.session.Steer(context.Background(), text)
}

// Interrupt aborts the running turn.
func (session *pigAgentSession) Interrupt(text *string) error {
	return session.session.Interrupt(context.Background(), text)
}

// Stop soft-stops the running turn.
func (session *pigAgentSession) Stop() error {
	return session.session.Stop(context.Background())
}

// Inspect is the session's own view of itself.
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

// Close ends the session. The kernel stays open: it holds the durable
// conversations of every identity.
func (session *pigAgentSession) Close() error {
	return session.session.Close()
}

// pigSessionIdentity is the identity one session is known by.
func pigSessionIdentity(request AgentSessionRequest) string {
	if request.Binding.InstanceId != "" {
		return request.Binding.InstanceId
	}
	return fmt.Sprintf("execution-%s", request.ExecutionId)
}

// pigSessionJson reads one session's own view as JSON.
func pigSessionJson(session AgentSession) ([]byte, error) {
	return json.Marshal(session.Inspect())
}
