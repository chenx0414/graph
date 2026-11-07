package graph

import (
	"encoding/json"
	"fmt"
	"strings"

	"bytes"
)

// DEFAULT_V2_RESERVE_TOKENS is what one v2 turn is expected to cost when the runtime has not said otherwise.
const DEFAULT_V2_RESERVE_TOKENS = 200_000

// KernelGraphLaneNetwork is the network grant a lane's nodes run under.
type KernelGraphLaneNetwork struct {
	RetrievalDomains []string
}

// KernelGraphLaneProgram is the program grant a lane's modules run under.
type KernelGraphLaneProgram struct {
	ReadPaths       []string
	Env             map[string]string
	NodeModulesPath *string
}

// KernelGraphLaneCredential is the credential a lane resolved for one model.
type KernelGraphLaneCredential struct {
	ApiKey        string
	CredentialId  *string
	Limit         *int
	SharedGroupId *string
	GroupLimit    *int
}

// KernelGraphLaneOptions is the production wiring of the v2 graph lane.
type KernelGraphLaneOptions struct {
	Kernel  *KernelStore
	Access  func() *ResolvedAccessPolicy
	Network *KernelGraphLaneNetwork
	Program *KernelGraphLaneProgram
	Catalog *Catalog
	Library *AgentContextLibrary
	// Codemode offers the kernel's codemode tool to the node sessions. It
	// is off by default.
	Codemode GraphCodemode
	// TokenBudget is the token budget a node runs under. Absent means unmetered - which is the
	// right default for a program node, but NOT for an agent that can spend real tokens, so the
	// runtime supplies one whenever limits are configured.
	TokenBudget   *TokenBudget
	ReserveTokens *float64
	// Directory is the models the runtime is configured with.
	Directory func() []ModelEntry
	// Scheduler is the host-wide gate for model requests.
	Scheduler *ModelScheduler
	// CredentialFor resolves the credential for a model entry; nil means the node cannot run.
	CredentialFor func(entry ModelEntry) *KernelGraphLaneCredential
	// InstancesDir is where per-node session directories live.
	InstancesDir string
	// StateDir is the state root; worker configs are written beneath it.
	StateDir  string
	GraphHome string
	// WorkspaceFor is the project workspace for a graph, resolved from its task row.
	WorkspaceFor func(graphId string) *string
	// Git is the real Git integration, used to give each node its OWN work copy.
	Git *GitIntegration
	// Artifacts is the artifact store a node's declared deliverable is published to.
	Artifacts *ArtifactWorkspace
	// GateFor is the gate for a node; absent means an unmetered passthrough.
	GateFor func(graphId, nodeId string) *SendGate
	// OnMainMessage answers a node's message to the main agent.
	OnMainMessage func(graphId, nodeId, text, requestId string) any
	// OnToolCall answers a tool the node called that the session does not offer.
	OnToolCall func(graphId, nodeId, name string, args any) PiToolAnswer
}

// ModelForContext names the node a model is selected for.
type ModelForContext struct {
	GraphId         string
	NodeId          string
	RevisionVersion int
}

// kernelGraphLaneNodeLocation is where one node works.
type kernelGraphLaneNodeLocation struct {
	Workspace string
	Base      string
}

// kernelGraphLaneNodeChannels are the node's own channels.
//
// The node's turn runs on the kernel, in this process. The telemetry it
// records, the events it publishes and the tools it may call are the lane's,
// and the kernel session reads them.
type kernelGraphLaneNodeChannels struct {
	// OnTelemetry records every tool call the node makes.
	OnTelemetry func(call PiAdapterToolCall)
	// OnEvent publishes one kernel event.
	OnEvent func(event any)
	// OnToolCall runs one tool the model called.
	OnToolCall func(name string, args any) (PiToolAnswer, error)
}

// ModelFor selects against immutable implementer history, including aliases and routing cycles.
func ModelFor(options KernelGraphLaneOptions, recipe string, context *ModelForContext) *ModelEntry {
	entry := options.Catalog.Definition(recipe)
	excluded := map[string]bool{}
	if entry.Review && context != nil {
		revision := options.Kernel.Revision(context.GraphId, context.RevisionVersion)
		if revision == nil {
			panic(fmt.Errorf("graph %s has no revision %d", context.GraphId, context.RevisionVersion))
		}
		definition := revision.Definition
		predecessors := map[string]map[string]bool{}
		connect := func(from, to string) {
			source := strings.Split(from, ".")[0]
			target := strings.Split(to, ".")[0]
			if predecessors[target] == nil {
				predecessors[target] = map[string]bool{}
			}
			predecessors[target][source] = true
		}
		// Disabling an edge cannot erase the identity of work already received over it.
		for _, edge := range definition.Edges {
			connect(edge.From, edge.To)
		}
		for _, delivery := range options.Kernel.DeliveryEdges(context.GraphId) {
			connect(delivery.From, delivery.To)
		}
		visited := map[string]bool{}
		var visit func(id string)
		visit = func(id string) {
			if visited[id] {
				return
			}
			visited[id] = true
			for _, call := range options.Kernel.ProviderCalls(context.GraphId, id) {
				execution := options.Kernel.Execution(call.ExecutionId)
				var producer *NodeDefinition
				if execution != nil {
					if row := options.Kernel.Revision(context.GraphId, execution.RevisionVersion); row != nil {
						if node, ok := row.Definition.Nodes[id]; ok {
							producer = &node
						}
					}
				}
				if producer == nil || producer.Recipe == "" {
					Raise("model_selection", "Implementer recipe history is unavailable for "+id)
				}
				if options.Catalog.Definition(producer.Recipe).Review {
					continue
				}
				if call.Model == nil {
					Raise("model_selection", "Implementer model history is unavailable for "+id)
				}
				excluded[call.Model.Id] = true
				if identity, ok := call.Model.Identity.(string); ok {
					excluded[identity] = true
				}
			}
			for upstream := range predecessors[id] {
				visit(upstream)
			}
		}
		visit(context.NodeId)
	}
	directory := []ModelEntry{}
	for _, model := range options.Directory() {
		if excluded[model.Id] || excluded[ModelIdentity(model)] {
			continue
		}
		directory = append(directory, model)
	}
	var definition *GraphDefinition
	if context != nil {
		if revision := options.Kernel.Revision(context.GraphId, context.RevisionVersion); revision != nil {
			definition = &revision.Definition
		}
	}
	requested := ""
	if context != nil && definition != nil {
		if node, ok := definition.Nodes[context.NodeId]; ok && node.Model != nil {
			requested = strings.TrimSpace(*node.Model)
		} else if definition.Defaults != nil && definition.Defaults.Model != nil {
			requested = strings.TrimSpace(*definition.Defaults.Model)
		}
	}
	input := SelectModelInput{Directory: directory}
	if requested != "" {
		input.Requested = requested
	}
	selected := SelectModel(input)
	if selected != nil {
		return selected
	}
	if len(directory) > 0 {
		return &directory[0]
	}
	return nil
}

// KernelGraphLane wires the production v2 lane.
func KernelGraphLane(options KernelGraphLaneOptions) *GraphLane {
	state := newKernelGraphLaneState(options)
	lane := NewGraphLane(state.laneOptions())
	lane.options.StopNode = func(graphID, nodeID, executionID string, attempt int) error {
		execution := state.options.Kernel.RunningExecution(graphID, nodeID)
		if execution == nil || execution.Id != executionID || execution.Attempt != attempt {
			return fmt.Errorf("The node execution has changed")
		}
		host, ok := state.hosts.Lookup(graphID + "/" + nodeID)
		if !ok {
			return fmt.Errorf("The node is not running")
		}
		return host.StopActive()
	}
	lane.options.Steer = func(graphID, nodeID, executionID, text, requestID string) error {
		execution := state.options.Kernel.RunningExecution(graphID, nodeID)
		if execution == nil || execution.Id != executionID {
			return fmt.Errorf("The node execution has changed")
		}
		host, ok := state.hosts.Lookup(graphID + "/" + nodeID)
		if !ok {
			return fmt.Errorf("The node is not accepting steering messages")
		}
		return host.Steer(text, requestID)
	}
	if state.options.TokenBudget != nil && state.options.ReserveTokens != nil {
		lane.options.TokenBudget = state.options.TokenBudget
		lane.options.ReserveTokens = state.options.ReserveTokens
	}
	if state.options.Artifacts != nil {
		lane.options.Artifacts = func(graphId string) *ArtifactWorkspace { return state.options.Artifacts }
	}
	registerNodeRecoveryResolver(state.options.Kernel.Store.Path, func(wrapper *FrozenExecutionRecovery) (*NodeRecoveryBinding, error) {
		id := wrapper.Record.ExecutionId
		execution := state.options.Kernel.Execution(id)
		if execution == nil {
			return nil, nil
		}
		// The kernel reports the frozen identity out of the record it
		// stored, so this reads the record's own identity twice over and
		// cannot fail on a record the kernel wrote. It stays as the lane's
		// refusal for a record that came from somewhere else.
		if wrapper.Identity != wrapper.Record.Identity {
			return nil, fmt.Errorf("Frozen node identity mismatch")
		}
		key := execution.TaskId + "/" + execution.NodeId
		state.restoring.Store(key, wrapper)
		originalState := execution.State
		state.options.Kernel.SetExecutionState(id, "running")
		defer state.options.Kernel.SetExecutionState(id, originalState)
		// The PiG kernel runs the node's turn in this process, so there is no
		// sidecar admission to restore. The frozen configuration is what the
		// re-run needs, and building the node's config from it is what puts
		// that configuration in the lane.
		return &NodeRecoveryBinding{Config: map[string]any{}}, nil
	})
	return lane
}

// kernelGraphLaneWorkingEnvironment is the environment the node's system prompt names.
//
// The key order is the TypeScript object literal order.
type kernelGraphLaneWorkingEnvironment struct {
	Workspace string                `json:"workspace"`
	Base      string                `json:"base"`
	Access    *ResolvedAccessPolicy `json:"access"`
}

// kernelGraphLaneBindingEnvironment is the environment the node binding stores.
//
// The key order is the TypeScript object literal order.
type kernelGraphLaneBindingEnvironment struct {
	Revision  int                   `json:"revision"`
	Workspace string                `json:"workspace"`
	Base      string                `json:"base"`
	Access    *ResolvedAccessPolicy `json:"access"`
}

// kernelGraphLaneAccess is the access policy of a session environment, when it has one.
func kernelGraphLaneAccess(environment *NodeSessionEnvironment) *ResolvedAccessPolicy {
	if environment == nil {
		return nil
	}
	return environment.Access
}

// kernelGraphLaneTruthy is the JavaScript truthiness of one value.
func kernelGraphLaneTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case float64:
		return typed != 0
	default:
		return true
	}
}

// kernelGraphLaneAdmittedNode is the admitted instance of one node.
func kernelGraphLaneAdmittedNode(kernel *KernelStore, graphId, nodeId string) KernelNodeView {
	for _, node := range kernel.ListNodes(graphId) {
		if node.NodeId == nodeId {
			return node
		}
	}
	return KernelNodeView{NodeId: nodeId}
}

// kernelGraphLaneUnlimited reports whether one execution may estimate missing usage.
func kernelGraphLaneUnlimited(kernel *KernelStore, executionId string) bool {
	execution := kernel.Execution(executionId)
	return execution != nil && execution.TokenBudget != nil && execution.TokenBudget.Unlimited
}

// kernelGraphLaneMessageText is the text of one assistant message.
func kernelGraphLaneMessageText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	parts, ok := content.([]any)
	if !ok {
		return ""
	}
	out := strings.Builder{}
	for _, part := range parts {
		record, ok := part.(map[string]any)
		if !ok {
			continue
		}
		value, present := record["text"]
		if !present || value == nil {
			continue
		}
		out.WriteString(fmt.Sprint(value))
	}
	return out.String()
}

// kernelGraphLaneStreamOptions are the provider options one turn runs with.
func kernelGraphLaneStreamOptions(options WorkerModelOptions, abort *AbortSignal) map[string]any {
	raw := map[string]any{}
	if options.Reasoning != nil {
		raw["reasoning"] = *options.Reasoning
	}
	if options.SessionId != nil {
		raw["sessionId"] = *options.SessionId
	}
	if options.Temperature != nil {
		raw["temperature"] = *options.Temperature
	}
	if options.MaxTokens != nil {
		raw["maxTokens"] = *options.MaxTokens
	}
	raw["signal"] = abort
	return raw
}

// kernelGraphLaneSlot reserves one credential slot for a node that has a limit.
func kernelGraphLaneSlot(options KernelGraphLaneOptions, model ModelEntry, credential *KernelGraphLaneCredential, executionId string) func(candidate ModelEntry) *piAdapterSlot {
	if options.Scheduler == nil || (credential.Limit == nil && credential.GroupLimit == nil) {
		return nil
	}
	return func(candidate ModelEntry) *piAdapterSlot {
		return &piAdapterSlot{acquire: func(signal *AbortSignal) (func(), error) {
			options.Kernel.SetExecutionWaiting(executionId, true)
			var release func()
			released := false
			releaseSlot := func() {
				if released {
					return
				}
				released = true
				if release != nil {
					release()
				}
			}
			var request func() SlotRequest
			request = func() SlotRequest {
				binding := options.CredentialFor(candidate)
				if binding == nil {
					panic(errorString("Bound model credential unavailable"))
				}
				credentialID := candidate.Provider
				if binding.CredentialId != nil {
					credentialID = *binding.CredentialId
				}
				return SlotRequest{
					CredentialId: credentialID, ApiKey: binding.ApiKey, Limit: binding.Limit,
					SharedGroupId: rsiStringValue(binding.SharedGroupId), GroupLimit: binding.GroupLimit,
					// The scheduler re-reads the binding when it grants the slot, so a
					// hot config apply cannot hand out a stale key.
					Refresh: request,
				}
			}
			defer func() {
				if recovered := recover(); recovered != nil {
					releaseSlot()
					options.Kernel.SetExecutionWaiting(executionId, false)
					panic(recovered)
				}
			}()
			for {
				before := request()
				acquired, err := options.Scheduler.Acquire(before, signal)
				if err != nil {
					options.Kernel.SetExecutionWaiting(executionId, false)
					return nil, err
				}
				after := request()
				if before.CredentialId == after.CredentialId && before.ApiKey == after.ApiKey {
					release = acquired
					break
				}
				acquired()
			}
			WaitForKernelExecutionSlot(options.Kernel, executionId, signal)
			return releaseSlot, nil
		}}
	}
}

// kernelGraphLaneToolCall is one tool call a node made.
type kernelGraphLaneToolCall struct {
	Name string `json:"name"`
	Args any    `json:"args"`
}

// kernelGraphLaneJSON serializes one value the way JSON.stringify does.
func kernelGraphLaneJSON(value any) string {
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
	return strings.TrimRight(buffer.String(), "\n")
}

// kernelGraphLaneEncodeURIComponent encodes one path segment the way encodeURIComponent does.
func kernelGraphLaneEncodeURIComponent(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	builder := strings.Builder{}
	for _, symbol := range []byte(value) {
		if strings.IndexByte(unreserved, symbol) >= 0 {
			builder.WriteByte(symbol)
			continue
		}
		builder.WriteString(fmt.Sprintf("%%%02X", symbol))
	}
	return builder.String()
}
