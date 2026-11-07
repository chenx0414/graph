package graph

import (
	"encoding/json"
	"fmt"
	"strings"

	"bytes"
)

const DEFAULT_V2_RESERVE_TOKENS = 200_000

type KernelGraphLaneNetwork struct {
	RetrievalDomains []string
}

type KernelGraphLaneProgram struct {
	ReadPaths       []string
	Env             map[string]string
	NodeModulesPath *string
}

type KernelGraphLaneCredential struct {
	ApiKey        string
	CredentialId  *string
	Limit         *int
	SharedGroupId *string
	GroupLimit    *int
}

type KernelGraphLaneOptions struct {
	Kernel  *KernelStore
	Access  func() *ResolvedAccessPolicy
	Network *KernelGraphLaneNetwork
	Program *KernelGraphLaneProgram
	Catalog *Catalog
	Library *AgentContextLibrary
	Codemode GraphCodemode
	TokenBudget   *TokenBudget
	ReserveTokens *float64
	Directory func() []ModelEntry
	Scheduler *ModelScheduler
	CredentialFor func(entry ModelEntry) *KernelGraphLaneCredential
	InstancesDir string
	StateDir  string
	GraphHome string
	WorkspaceFor func(graphId string) *string
	Git *GitIntegration
	Artifacts *ArtifactWorkspace
	GateFor func(graphId, nodeId string) *SendGate
	OnMainMessage func(graphId, nodeId, text, requestId string) any
	OnToolCall func(graphId, nodeId, name string, args any) PiToolAnswer
}

type ModelForContext struct {
	GraphId         string
	NodeId          string
	RevisionVersion int
}

type kernelGraphLaneNodeLocation struct {
	Workspace string
	Base      string
}

type kernelGraphLaneNodeChannels struct {
	OnTelemetry func(call PiAdapterToolCall)
	OnEvent func(event any)
	OnToolCall func(name string, args any) (PiToolAnswer, error)
}

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
		if wrapper.Identity != wrapper.Record.Identity {
			return nil, fmt.Errorf("Frozen node identity mismatch")
		}
		key := execution.TaskId + "/" + execution.NodeId
		state.restoring.Store(key, wrapper)
		originalState := execution.State
		state.options.Kernel.SetExecutionState(id, "running")
		defer state.options.Kernel.SetExecutionState(id, originalState)
		return &NodeRecoveryBinding{Config: map[string]any{}}, nil
	})
	return lane
}

type kernelGraphLaneWorkingEnvironment struct {
	Workspace string                `json:"workspace"`
	Base      string                `json:"base"`
	Access    *ResolvedAccessPolicy `json:"access"`
}

type kernelGraphLaneBindingEnvironment struct {
	Revision  int                   `json:"revision"`
	Workspace string                `json:"workspace"`
	Base      string                `json:"base"`
	Access    *ResolvedAccessPolicy `json:"access"`
}

func kernelGraphLaneAccess(environment *NodeSessionEnvironment) *ResolvedAccessPolicy {
	if environment == nil {
		return nil
	}
	return environment.Access
}

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

func kernelGraphLaneAdmittedNode(kernel *KernelStore, graphId, nodeId string) KernelNodeView {
	for _, node := range kernel.ListNodes(graphId) {
		if node.NodeId == nodeId {
			return node
		}
	}
	return KernelNodeView{NodeId: nodeId}
}

func kernelGraphLaneUnlimited(kernel *KernelStore, executionId string) bool {
	execution := kernel.Execution(executionId)
	return execution != nil && execution.TokenBudget != nil && execution.TokenBudget.Unlimited
}

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

type kernelGraphLaneToolCall struct {
	Name string `json:"name"`
	Args any    `json:"args"`
}

func kernelGraphLaneJSON(value any) string {
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
	return strings.TrimRight(buffer.String(), "\n")
}

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
