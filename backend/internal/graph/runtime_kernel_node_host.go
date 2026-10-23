package graph

import (
	"encoding/json"
	"fmt"
	"path/filepath"
)

// NodeSessionBinding is the resident worker's persisted identity.
type NodeSessionBinding struct {
	InstanceId        string `json:"instanceId"`
	NodeId            string `json:"nodeId"`
	DefinitionVersion string `json:"definitionVersion"`
}

// NodeSessionEnvironment is the frozen workspace a session was built from.
type NodeSessionEnvironment struct {
	Revision  int                   `json:"revision"`
	Workspace string                `json:"workspace"`
	Base      string                `json:"base"`
	Access    *ResolvedAccessPolicy `json:"access"`
}

// NodeSession is one v2 node's assembled prompt, tools, and digests.
type NodeSession struct {
	Environment         *NodeSessionEnvironment
	Role                string
	Operation           *CapabilityOperation
	Close               func()
	Binding             NodeSessionBinding
	SystemPrompt        string
	AllowedToolNames    []string
	StateDir            string
	BundleDigest        string
	ToolPolicyDigest    string
	RuntimePolicyDigest string
}

// NodeSessionOptions assembles one node from its immutable recipe.
type NodeSessionOptions struct {
	Frozen             map[string]any
	RetainCapabilities bool
	Access             *ResolvedAccessPolicy
	Bindings           *NodeSessionBindings
	Kernel             *KernelStore
	Catalog            *Catalog
	GraphId            string
	NodeId             string
	RevisionVersion    int
	Workspace          string
	ProjectRoot        string
	InstancesDir       string
	Gate               *SendGate
	Library            *AgentContextLibrary
	// DaemonNativeTools makes the daemon provide the native tools the
	// TypeScript SDK used to publish. It is set when the kernel runs without
	// an SDK of its own, so nothing else would offer read, write, edit, ls,
	// find, grep and the shell to the model.
	DaemonNativeTools bool
}

// NodeSessionBindings are the host tools a node may call.
type NodeSessionBindings struct {
	Peers           any
	Artifacts       any
	CommitWorkspace func(paths []string, message string) any
	Fetch           func(url string, signal *AbortSignal) RetrievalResult
}

// GraphSectionQuery reads one slice of a frozen definition.
type GraphSectionQuery struct {
	Section string
	Id      *string
	After   *int
	Limit   *int
}

func kernelNodeRecipe(kernel *KernelStore, graphID, nodeID string, revisionVersion int) string {
	revision := kernel.Revision(graphID, revisionVersion)
	if revision == nil {
		panic(fmt.Errorf("graph %s has no revision %d", graphID, revisionVersion))
	}
	node, ok := revision.Definition.Nodes[nodeID]
	if !ok {
		panic(fmt.Errorf("revision %d of %s declares no node %s", revisionVersion, graphID, nodeID))
	}
	if node.Recipe == "" {
		panic(fmt.Errorf("node %s of graph %s is a command node and has no recipe to assemble", nodeID, graphID))
	}
	return node.Recipe
}

func kernelNodeInstanceID(graphID, nodeID string) string {
	return "k-" + graphID + "-" + nodeID
}

func kernelPassthroughGate() SendGate {
	return SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any { return send() },
		Settle:   func(id string, usage *TokenUsage) {},
	}
}

// NodeSessionRequest assembles one node's session from its recipe.
func NodeSessionRequest(options NodeSessionOptions) NodeSession {
	recipe := kernelNodeRecipe(options.Kernel, options.GraphId, options.NodeId, options.RevisionVersion)
	if options.Frozen == nil && !options.Catalog.HasDefinition(recipe) {
		panic(fmt.Errorf("node %s names recipe %s, which the catalog does not hold", options.NodeId, recipe))
	}
	action := "work"
	if options.Frozen != nil {
		if mapString(asMap(asMap(options.Frozen["snapshot"])["configuration"])["nodeExecutionConfiguration"].(map[string]any), "role") == "reviewer" {
			action = "review"
		}
	} else if options.Catalog.Definition(recipe).Review {
		action = "review"
	}
	assemblyInput := AgentContextAssemblyOptions{
		Catalog: options.Catalog, DefinitionVersion: recipe, Action: action, Runtime: "node", Workspace: options.Workspace, Library: options.Library,
	}
	if options.ProjectRoot != "" {
		assemblyInput.SkillProjectRoot = options.ProjectRoot
	}
	if options.Frozen != nil {
		descriptor := asMap(options.Frozen["restoredDescriptor"])
		body, _ := json.Marshal(descriptor["facts"])
		facts := []ResolvedCapabilityFact{}
		if err := json.Unmarshal(body, &facts); err != nil {
			panic(err)
		}
		assemblyInput.FrozenFacts = facts
	}
	assembly := OpenAgentContextAssembly(assemblyInput)
	row, ok := g5One(options.Kernel.Db, "SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?", options.GraphId, options.NodeId)
	instanceID := kernelNodeInstanceID(options.GraphId, options.NodeId)
	if ok {
		instanceID = g5Str(row["instance_id"])
	}
	scratchDir := filepath.Join(options.InstancesDir, instanceID, "capability-scratch")
	gate := kernelPassthroughGate()
	if options.Gate != nil {
		gate = *options.Gate
	}
	commands := OpenWorkspaceCommandRunner(options.Workspace, filepath.Join(scratchDir, "commands"), gate, nil, nil, false, options.Access, false, 0)
	operationGate := kernelPassthroughGate()
	if options.Gate != nil {
		operationGate = *options.Gate
	}
	var nativeToolInput *AgentToolsInput
	operationInput := CapabilityOperationOptions{
		Workspace: options.Workspace, ScratchDir: scratchDir, Action: action, NativeTools: []string{"bash"},
		DisabledTools: assembly.DisabledTools, Gate: operationGate, Access: options.Access,
		HostTools: func(readRoots []string) []ToolDefinition {
			role := "worker"
			if action == "review" {
				role = "reviewer"
			}
			tools := AgentToolsInput{
				Workspace: options.Workspace, Role: role, ReadRoots: append([]string{}, readRoots...), Catalog: options.Catalog, Access: options.Access,
				ReadGraph: func(input GraphSectionQuery) any {
					execution, found := g5One(options.Kernel.Db, "SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", options.GraphId, options.NodeId)
					if !found {
						Raise("invalid_execution", "Graph definition reads require an active execution")
					}
					definition := options.Kernel.Revision(options.GraphId, int(g5Int(execution["revision_version"]))).Definition
					section := input.Section
					if section != "nodes" && section != "modules" && section != "edges" && section != "protocols" && section != "acceptance" && section != "inputs" && section != "outputs" {
						Raise("invalid_query", "Unknown graph definition section")
					}
					after := 0
					if input.After != nil {
						after = *input.After
					}
					limit := 20
					if input.Limit != nil {
						limit = *input.Limit
					}
					if !isSafeInteger(after) || after < 0 || !isSafeInteger(limit) || limit < 1 || limit > 50 {
						Raise("invalid_query", "after must be nonnegative; limit must be 1–50")
					}
					entries := []kernelSectionEntry{}
					if section == "acceptance" {
						for _, value := range definition.Acceptance {
							entries = append(entries, kernelSectionEntry{id: value.Id, value: value})
						}
					} else {
						entries = kernelSectionEntries(definition, section)
					}
					selected := []kernelSectionEntry{}
					if input.Id == nil {
						start := after
						end := after + limit
						if start < 0 {
							start = 0
						}
						if start > len(entries) {
							start = len(entries)
						}
						if end > len(entries) {
							end = len(entries)
						}
						if end < start {
							end = start
						}
						selected = entries[start:end]
					} else {
						for _, entry := range entries {
							if entry.id == *input.Id {
								selected = append(selected, entry)
							}
						}
					}
					if input.Id != nil && len(selected) == 0 {
						Raise("not_found", "No "+section+" object named "+*input.Id)
					}
					items := []any{}
					for _, entry := range selected {
						items = append(items, map[string]any{"id": entry.id, "value": entry.value})
					}
					var next any
					if input.Id == nil && after+len(selected) < len(entries) {
						next = after + len(selected)
					}
					return map[string]any{"graphId": options.GraphId, "revision": g5Int(execution["revision_version"]), "section": section, "total": len(entries), "items": items, "nextAfter": next}
				},
				Run: func(command string, args []string, signal *AbortSignal) CommandResult {
					return commands.Run(command, args, signal)
				},
			}
			built := tools
			nativeToolInput = &built
			if options.Bindings != nil {
				tools.Peers = options.Bindings.Peers
				tools.Artifacts = options.Bindings.Artifacts
				tools.CommitWorkspace = options.Bindings.CommitWorkspace
				tools.Fetch = options.Bindings.Fetch
			}
			return AgentTools(tools)
		},
	}
	operationInput.NativeToolsProvider = func(granted []string) []ToolDefinition {
		if nativeToolInput == nil || !options.DaemonNativeTools {
			return nil
		}
		return PigNativeTools(*nativeToolInput, granted)
	}
	operation := assembly.Bundle.OpenOperation(operationInput)
	composed := assembly.ForOperation(operation).Composed.Text
	role := "worker"
	if action == "review" {
		role = "reviewer"
	}
	request := NodeSession{
		Role: role,
		Close: func() {
			if operation.Close != nil {
				operation.Close()
			}
			commands.Close()
		},
		Binding:      NodeSessionBinding{InstanceId: instanceID, NodeId: options.NodeId, DefinitionVersion: recipe},
		SystemPrompt: composed, AllowedToolNames: append([]string{}, operation.AllowedToolNames...),
		StateDir: filepath.Join(options.InstancesDir, instanceID), BundleDigest: operation.BundleDigest,
		ToolPolicyDigest: operation.ToolPolicyDigest, RuntimePolicyDigest: operation.RuntimePolicyDigest,
	}
	if options.RetainCapabilities {
		copy := operation
		request.Operation = &copy
	} else {
		request.Close()
	}
	return request
}

type kernelSectionEntry struct {
	id    string
	value any
}

func kernelSectionEntries(definition GraphDefinition, section string) []kernelSectionEntry {
	out := []kernelSectionEntry{}
	switch section {
	case "nodes":
		for _, id := range sortedKeys(definition.Nodes) {
			out = append(out, kernelSectionEntry{id, definition.Nodes[id]})
		}
	case "modules":
		for _, id := range sortedKeys(definition.Modules) {
			out = append(out, kernelSectionEntry{id, definition.Modules[id]})
		}
	case "edges":
		for _, id := range sortedKeys(definition.Edges) {
			out = append(out, kernelSectionEntry{id, definition.Edges[id]})
		}
	case "protocols":
		for _, id := range sortedKeys(definition.Protocols) {
			out = append(out, kernelSectionEntry{id, definition.Protocols[id]})
		}
	case "inputs":
		for _, id := range sortedKeys(definition.Inputs) {
			out = append(out, kernelSectionEntry{id, definition.Inputs[id]})
		}
	case "outputs":
		for _, id := range sortedKeys(definition.Outputs) {
			out = append(out, kernelSectionEntry{id, definition.Outputs[id]})
		}
	}
	return out
}
