package graph

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The production wiring of the v2 graph lane (Issue #1 §13.8).
//
// Everything the lane needs exists separately: the lane drives a graph (GraphLane), the
// session for a node comes from its recipe (nodeSessionRequest), and the worker reaches the
// provider with the host's credential. This assembles them into the one call `Execution`
// needs - `graphs()` - so a confirmed v2 graph runs in the running product instead of only in
// tests.
//
// Credentials stay with the host (§3): the resident worker requests a model call over IPC;
// the host selects the model, admits each send and records its authoritative usage.

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
	// TokenBudget is the token budget a node runs under. Absent means unmetered - which is the
	// right default for a program node, but NOT for an agent that can spend real tokens, so the
	// runtime supplies one whenever limits are configured.
	TokenBudget   *TokenBudget
	ReserveTokens *float64
	// Directory is the models the runtime is configured with.
	Directory func() []ModelEntry
	// Preferences is the per-grade model preference of the runtime.
	Preferences func() map[ModelGrade][]string
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
	OnToolCall func(graphId, nodeId, name string, args any) ResidentToolAnswer
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

// kernelGraphLaneHost adapts one resident host to the executor's host contract.
type kernelGraphLaneHost struct {
	host *ResidentHost
}

// Start starts (or restarts) the resident process.
func (adapter *kernelGraphLaneHost) Start() HostProcess {
	inspect, err := adapter.host.Start()
	if err != nil {
		panic(err)
	}
	return HostProcess{ProcessId: inspect.ProcessId}
}

// Alive reports whether the resident process is still running.
func (adapter *kernelGraphLaneHost) Alive() bool {
	return adapter.host.Alive()
}

// Turn runs one turn over the resident session.
func (adapter *kernelGraphLaneHost) Turn(text string) TurnReport {
	result, err := adapter.host.Turn(text)
	if err != nil {
		message := err.Error()
		return TurnReport{Error: &message}
	}
	report := TurnReport{Done: true}
	if result.Usage != nil {
		accounted := result.Usage.Accounted != nil && *result.Usage.Accounted
		report.Usage = &TurnUsage{Total: float64(result.Usage.Total), Accounted: accounted}
	}
	return report
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
		deliveries := kernelRows(options.Kernel.Db, "SELECT from_endpoint,to_endpoint FROM kernel_deliveries WHERE task_id=?", context.GraphId)
		for _, delivery := range deliveries {
			connect(graphDBString(delivery, "from_endpoint"), graphDBString(delivery, "to_endpoint"))
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
	input := SelectModelInput{Grade: entry.RecommendedGrade, Directory: directory}
	if requested != "" {
		input.Requested = requested
	}
	if options.Preferences != nil {
		input.Preferences = options.Preferences()
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

// kernelGraphLaneSubmitSchema is the argument schema of the node's submit tool.
//
// The key order is the TypeScript object literal order: a Go map would sort the
// keys, and the schema the model reads is part of the tool contract.
type kernelGraphLaneSubmitSchema struct {
	Type       string                          `json:"type"`
	Properties kernelGraphLaneSubmitProperties `json:"properties"`
	Required   []string                        `json:"required"`
}

// kernelGraphLaneSubmitProperties is the property list of the submit schema.
type kernelGraphLaneSubmitProperties struct {
	Outputs kernelGraphLaneSubmitOutputs `json:"outputs"`
}

// kernelGraphLaneSubmitOutputs is the per-output entry of the submit schema.
type kernelGraphLaneSubmitOutputs struct {
	Type                 string                           `json:"type"`
	Description          string                           `json:"description"`
	AdditionalProperties kernelGraphLaneSubmitOutputValue `json:"additionalProperties"`
}

// kernelGraphLaneSubmitOutputValue is the shape of one declared output.
type kernelGraphLaneSubmitOutputValue struct {
	Type       string                                `json:"type"`
	Properties kernelGraphLaneSubmitOutputProperties `json:"properties"`
	Required   []string                              `json:"required"`
}

// kernelGraphLaneSubmitOutputProperties are the fields of one declared output.
type kernelGraphLaneSubmitOutputProperties struct {
	Enable map[string]any `json:"enable"`
	Value  map[string]any `json:"value"`
}

// kernelGraphLaneSubmitTool is the node's graph output tool.
//
// The argument shape is part of the contract, not a detail the model has to guess: a
// call that puts its outputs anywhere else is refused by name (HB-324).
func kernelGraphLaneSubmitTool() PiWorkerTool {
	return PiWorkerTool{
		Name:  "submit",
		Label: "Submit",
		Description: "Submit this node's required outputs to the graph kernel. Call it as " +
			"{\"outputs\":{\"<output name>\":{\"enable\":true,\"value\":<value>}}}; every required output must appear with enable:true.",
		Parameters: kernelGraphLaneSubmitSchema{
			Type: "object",
			Properties: kernelGraphLaneSubmitProperties{
				Outputs: kernelGraphLaneSubmitOutputs{
					Type:        "object",
					Description: "One entry per output this node declares; enable:true for the required ones.",
					AdditionalProperties: kernelGraphLaneSubmitOutputValue{
						Type: "object",
						Properties: kernelGraphLaneSubmitOutputProperties{
							Enable: map[string]any{"type": "boolean"},
							Value:  map[string]any{},
						},
						Required: []string{"enable"},
					},
				},
			},
			Required: []string{"outputs"},
		},
	}
}

// KernelGraphLane builds the production v2 lane. A node's session is assembled once and reused for the life
// of the lane, so the same node keeps one resident process across the graph's turns (§7).
func KernelGraphLane(options KernelGraphLaneOptions) *GraphLane {
	closing := false
	restoring := map[string]map[string]any{}
	hosts := map[string]*ResidentHost{}
	sessions := map[string]NodeSession{}
	sessionRevisions := map[string]string{}
	hostConfigs := map[string]string{}
	boundModels := map[string]ModelEntry{}
	preparedReviewExecutions := map[string]string{}

	// The lane serves every graph of this runtime and every node runs in its own
	// goroutine, so the per-node tables above are shared state. A concurrent
	// write to one of them is a fatal error in Go, not a lost update: two nodes
	// of one graph preparing their sessions at the same time must not take the
	// daemon down. Every access goes through the accessors below.
	var stateMutex sync.Mutex
	restoringOf := func(key string) map[string]any {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		return restoring[key]
	}
	setRestoring := func(key string, wrapper map[string]any) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		restoring[key] = wrapper
	}
	forgetRestoring := func(key string) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		delete(restoring, key)
	}
	hostOf := func(key string) (*ResidentHost, bool) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		host, ok := hosts[key]
		return host, ok
	}
	hostConfigOf := func(key string) string {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		return hostConfigs[key]
	}
	setHost := func(key string, host *ResidentHost, signature string) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		hosts[key] = host
		hostConfigs[key] = signature
	}
	forgetHost := func(key string) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		delete(hosts, key)
		delete(hostConfigs, key)
	}
	sessionOf := func(key string) (NodeSession, bool) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		session, ok := sessions[key]
		return session, ok
	}
	sessionRevisionOf := func(key string) string {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		return sessionRevisions[key]
	}
	setSession := func(key string, session NodeSession, configuration string) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		sessions[key] = session
		sessionRevisions[key] = configuration
	}
	boundModelOf := func(key string) (ModelEntry, bool) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		model, ok := boundModels[key]
		return model, ok
	}
	setBoundModel := func(key string, model ModelEntry) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		boundModels[key] = model
	}
	reviewExecutionOf := func(key string) string {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		return preparedReviewExecutions[key]
	}
	setReviewExecution := func(key string, executionID string) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		preparedReviewExecutions[key] = executionID
	}
	// hostKeys and sessionKeys snapshot the keys of one table so a caller can
	// act on them outside the lock.
	hostKeys := func() []string {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		keys := make([]string, 0, len(hosts))
		for key := range hosts {
			keys = append(keys, key)
		}
		return keys
	}
	sessionKeys := func() []string {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		keys := make([]string, 0, len(sessions))
		for key := range sessions {
			keys = append(keys, key)
		}
		return keys
	}
	// forgetNode drops every per-node entry of one key and returns its session.
	forgetNode := func(key string) (NodeSession, bool) {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		session, ok := sessions[key]
		delete(hosts, key)
		delete(hostConfigs, key)
		delete(boundModels, key)
		delete(preparedReviewExecutions, key)
		delete(sessions, key)
		delete(sessionRevisions, key)
		return session, ok
	}
	// resetLaneTables empties the tables that outlive a single graph.
	resetLaneTables := func() {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		hostConfigs = map[string]string{}
		boundModels = map[string]ModelEntry{}
	}

	nodeDefinition := func(graphId, nodeId string, revisionVersion *int) *NodeDefinition {
		active := kernelRow(options.Kernel.Db, "SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
		revision := revisionVersion
		if revision == nil && active != nil {
			value := int(graphDBInt(active, "revision_version"))
			revision = &value
		}
		var definition *GraphDefinition
		if revision == nil {
			if latest := options.Kernel.LatestRevision(graphId); latest != nil {
				definition = &latest.Definition
			}
		} else if row := options.Kernel.Revision(graphId, *revision); row != nil {
			definition = &row.Definition
		}
		if definition == nil {
			return nil
		}
		node, ok := definition.Nodes[nodeId]
		if !ok {
			return nil
		}
		return &node
	}
	// Use the execution's frozen location, including publication during a concurrent patch.
	nodeLocation := func(graphId, nodeId string, revisionVersion *int, prepare bool) (location *kernelGraphLaneNodeLocation) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if failure, ok := recovered.(*RuntimeError); ok {
				panic(failure)
			}
			Raise("invalid_workspace", "Node workspace cannot be opened: "+rsiPanicMessage(recovered))
		}()
		if frozen := restoringOf(graphId + "/" + nodeId); frozen != nil {
			policy := asMap(frozen["restoredPolicy"])
			configuration := asMap(asMap(frozen["snapshot"])["configuration"])
			return &kernelGraphLaneNodeLocation{Workspace: mapString(policy, "workspace"), Base: mapString(asMap(configuration["nodeExecutionConfiguration"]), "base")}
		}
		node := nodeDefinition(graphId, nodeId, revisionVersion)
		selected := "auto"
		if node != nil && node.Workspace != nil {
			selected = node.Workspace.Base
		}
		admitted := kernelRow(options.Kernel.Db, "SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?", graphId, nodeId)
		key := graphId + "/" + nodeId
		execution := kernelRow(options.Kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
		// Prepare each new review against the current integration. Retries, recovery
		// after a provider call, and settlement retain the tree already observed.
		reseed := false
		if prepare && execution != nil && node != nil && node.Recipe != "" &&
			options.Catalog.HasDefinition(node.Recipe) && options.Catalog.Definition(node.Recipe).Review &&
			reviewExecutionOf(key) != graphDBString(execution, "id") {
			reseed = kernelRow(options.Kernel.Db, "SELECT 1 FROM kernel_provider_calls WHERE execution_id=? LIMIT 1", graphDBString(execution, "id")) == nil
		}
		var copy *string
		if selected != "project" && options.Git != nil && admitted != nil {
			instanceID := graphDBString(admitted, "instance_id")
			action := "work"
			if reseed {
				action = "review"
			}
			copy = options.Git.Workspace(graphId, &instanceID, nodeId, "agent", action)
		}
		if copy != nil && reseed {
			setReviewExecution(key, graphDBString(execution, "id"))
		}
		if selected == "worktree" && copy == nil {
			Raise("invalid_workspace", "Node requests a worktree; prepare this graph with a targetBranch first")
		}
		base := copy
		if base == nil {
			base = options.WorkspaceFor(graphId)
		}
		if base == nil {
			return nil
		}
		root, err := filepath.EvalSymlinks(*base)
		if err != nil {
			panic(err)
		}
		relative := "."
		if node != nil && node.Workspace != nil && node.Workspace.Path != "" {
			relative = node.Workspace.Path
		}
		workspace, err := filepath.EvalSymlinks(filepath.Join(root, relative))
		if err != nil {
			panic(err)
		}
		within, err := filepath.Rel(root, workspace)
		if err != nil {
			panic(err)
		}
		if within == ".." || strings.HasPrefix(within, "../") || strings.HasPrefix(within, "/") {
			Raise("permission", "Node workspace path escapes its declared base")
		}
		info, err := os.Stat(workspace)
		if err != nil {
			panic(err)
		}
		if !info.IsDir() {
			Raise("invalid_workspace", "Node workspace path must be an existing directory")
		}
		kind := "project"
		if copy != nil {
			kind = "worktree"
		}
		return &kernelGraphLaneNodeLocation{Workspace: workspace, Base: kind}
	}
	nodeWorkspace := func(graphId, nodeId string, revisionVersion *int) *string {
		location := nodeLocation(graphId, nodeId, revisionVersion, false)
		if location == nil {
			return nil
		}
		workspace := location.Workspace
		return &workspace
	}
	nodeAccess := func(graphId, nodeId string, revisionVersion int) *ResolvedAccessPolicy {
		if frozen := restoringOf(graphId + "/" + nodeId); frozen != nil {
			configuration := asMap(asMap(frozen["snapshot"])["configuration"])
			body, _ := json.Marshal(asMap(configuration["nodeExecutionConfiguration"])["access"])
			var access ResolvedAccessPolicy
			if err := json.Unmarshal(body, &access); err != nil {
				panic(err)
			}
			return &access
		}
		var requested any
		if node := nodeDefinition(graphId, nodeId, &revisionVersion); node != nil && node.Access != nil {
			requested = node.Access
		}
		context := AccessPolicyContext{StateDir: options.StateDir, GraphHome: options.GraphHome}
		ceiling := ResolveAccessPolicy(StandardAccessPolicy(), context)
		// The TypeScript read is `options.access?.() ?? resolveAccessPolicy(...)`, so a host
		// that has no ceiling to give falls back to the standard policy.
		if options.Access != nil {
			if resolved := options.Access(); resolved != nil {
				ceiling = resolved
			}
		}
		return NodeAccessPolicy(requested, ceiling, context)
	}
	sessionFor := func(graphId, nodeId string, revisionVersion int) NodeSession {
		if closing {
			panic(errorString("Graph runtime is closing"))
		}
		key := graphId + "/" + nodeId
		if frozen := restoringOf(key); frozen != nil {
			active := kernelRow(options.Kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
			if active != nil && mapString(active, "id") != mapString(asMap(frozen["snapshot"]), "executionId") {
				forgetRestoring(key)
			}
		}
		cached, hasCached := sessionOf(key)
		revision := options.Kernel.Revision(graphId, revisionVersion)
		if revision == nil {
			panic(errorString(fmt.Sprintf("graph %s has no revision to run", graphId)))
		}
		recipe := ""
		if node, ok := revision.Definition.Nodes[nodeId]; ok {
			recipe = node.Recipe
		}
		role := "worker"
		if frozen := restoringOf(key); frozen != nil {
			configuration := asMap(asMap(frozen["snapshot"])["configuration"])
			role = mapString(asMap(configuration["nodeExecutionConfiguration"]), "role")
		} else if recipe != "" && options.Catalog.Definition(recipe).Review {
			role = "reviewer"
		}
		var prompts []string
		if options.Library != nil && restoringOf(key) == nil {
			definitionID := nodeId
			if recipe != "" {
				definitionID = strings.Split(recipe, "@")[0]
			}
			common, err := options.Library.Prompt("rules/common.md")
			if err != nil {
				panic(err)
			}
			rules, err := options.Library.Prompt("rules/" + role + ".md")
			if err != nil {
				panic(err)
			}
			tools, err := options.Library.Prompt("tools/" + role + ".md")
			if err != nil {
				panic(err)
			}
			runtime, err := options.Library.Prompt("runtime/node.md")
			if err != nil {
				panic(err)
			}
			prompts = []string{common, rules, tools, runtime, options.Library.AgentPrompt(definitionID, nil)}
		}
		location := nodeLocation(graphId, nodeId, &revisionVersion, true)
		if location == nil {
			Raise("invalid_workspace", fmt.Sprintf("graph %s node %s has no workspace", graphId, nodeId))
		}
		workspace := location.Workspace
		access := nodeAccess(graphId, nodeId, revisionVersion)
		configuration := CanonicalJSON(map[string]any{
			"recipe": recipe, "prompts": prompts, "workspace": workspace, "access": access, "network": options.Network,
		})
		if hasCached && sessionRevisionOf(key) == configuration {
			return cached
		}
		if hasCached {
			if host, ok := hostOf(key); ok {
				_ = host.Stop()
			}
			forgetHost(key)
			if cached.Close != nil {
				cached.Close()
			}
		}
		domains := []string{}
		if options.Network != nil {
			domains = options.Network.RetrievalDomains
		}
		unrestricted := access.Network == "unrestricted"
		var retrieval *RetrievalBroker
		if len(domains) > 0 || unrestricted {
			retrieval = CreateRetrievalBroker(domains, KernelToolGate(options.Kernel, graphId, nodeId, "retrieval", func() bool { return closing }), unrestricted, 0, 0)
		}
		var gate *SendGate
		if options.GateFor != nil {
			gate = options.GateFor(graphId, nodeId)
		}
		if gate == nil {
			tool := KernelToolGate(options.Kernel, graphId, nodeId, "tool", func() bool { return closing })
			gate = &tool
		}
		bindings := &NodeSessionBindings{}
		if retrieval != nil {
			broker := retrieval
			bindings.Fetch = func(url string, signal *AbortSignal) RetrievalResult {
				return broker.Fetch(url, signal)
			}
		}
		if options.Git != nil && options.Kernel.Store.Task(graphId).IntegrationBranch != nil && location.Base == "worktree" && role != "reviewer" {
			bindings.CommitWorkspace = func(paths []string, message string) any {
				return options.Git.Exclusive(graphId, func() any {
					task := options.Kernel.Store.Task(graphId)
					execution := kernelRow(options.Kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
					if execution == nil || closing || task.Paused != 0 || options.Kernel.NodeState(graphId, nodeId).Paused || phaseClosed(task.Phase) {
						Raise("paused", "Workspace commit is closed")
					}
					unknown := kernelRow(options.Kernel.Db, "SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state='unknown' LIMIT 1", graphId, nodeId)
					if unknown != nil {
						row := options.Kernel.Execution(graphDBString(execution, "id"))
						if row == nil || row.TokenBudget == nil || !row.TokenBudget.Unlimited {
							Raise("budget", "Reconcile unknown provider usage before committing work")
						}
					}
					admitted := kernelGraphLaneAdmittedNode(options.Kernel, graphId, nodeId)
					return options.Git.CommitWorkspace(GitCommitInput{
						Id: graphDBString(execution, "id"), TaskId: graphId, NodeId: nodeId, InstanceId: admitted.InstanceId,
						Recipe: recipe, Workspace: workspace, Paths: paths, Message: message,
					})
				})
			}
		}
		// The peer surface is the shape the agent tools read: PiAdapterPeerTools.
		// TODO(port): the TypeScript peer entry is {id, href}; the Go peer node has no
		// href field, so the graph:// address of a peer is not reported to the model.
		bindings.Peers = PiAdapterPeerTools{
			List: func() []PiAdapterPeerNode {
				peers := []PiAdapterPeerNode{}
				latest := options.Kernel.LatestRevision(graphId)
				if latest != nil {
					for _, id := range sortedKeys(latest.Definition.Nodes) {
						peers = append(peers, PiAdapterPeerNode{Id: id})
					}
				}
				peers = append(peers, PiAdapterPeerNode{Id: "main"})
				return peers
			},
			Send: func(request PiAdapterPeerRequest) any {
				if request.To == "main" {
					if options.OnMainMessage == nil {
						panic(errorString("Main agent message channel unavailable"))
					}
					return options.OnMainMessage(graphId, nodeId, request.Text, request.RequestId)
				}
				return SendKernelNodeMessage(options.Kernel, graphId, request.To, NodeMessageInput{Text: request.Text, RequestID: request.RequestId}, &nodeId)
			},
		}
		if options.Artifacts != nil {
			artifacts := options.Artifacts
			// The artifact surface is the shape the agent tools read: AgentToolsArtifactService.
			bindings.Artifacts = &AgentToolsArtifactService{
				AllowedNamespaces: []string{"plans", "research", "reviews", "deliverables", "summaries"},
				CanPromote:        false,
				List: func(query ArtifactQuery) ArtifactPage {
					return artifacts.ListGraph(graphId, query)
				},
				Get: func(id string, version *int) ArtifactRecord {
					return artifacts.Get(graphId, id, version, "")
				},
				Read: func(id string, version int, maxBytes int) ArtifactRead {
					return artifacts.Read(graphId, id, version, maxBytes, "")
				},
				Retire: func(id string, version int, reason string, requestId string) ArtifactRecord {
					execution := kernelRow(options.Kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
					if execution == nil {
						panic(errorString("No active execution"))
					}
					admitted := kernelGraphLaneAdmittedNode(options.Kernel, graphId, nodeId)
					return artifacts.Retire(graphId, id, version, reason, requestId, ArtifactProducer{
						NodeId: nodeId, InstanceId: admitted.InstanceId, OperationId: graphDBString(execution, "id"), ActivationId: graphDBString(execution, "id"),
					})
				},
				Publish: func(input PublishArtifactInput) ArtifactRecord {
					execution := kernelRow(options.Kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
					if execution == nil {
						panic(errorString("No active execution"))
					}
					admitted := kernelGraphLaneAdmittedNode(options.Kernel, graphId, nodeId)
					published := input
					published.TaskId = graphId
					published.Workspace = workspace
					published.Producer = ArtifactProducer{
						NodeId: nodeId, InstanceId: admitted.InstanceId, OperationId: graphDBString(execution, "id"), ActivationId: graphDBString(execution, "id"),
					}
					return artifacts.Publish(published)
				},
				// The TypeScript binding has no promote method at all; a node may not
				// promote, so the tool is never offered and this only guards a direct call.
				Promote: func(input ArtifactPromoteInput) ArtifactRecord {
					Raise("forbidden", "This node may not promote artifacts")
					return ArtifactRecord{}
				},
			}
		}
		sessionOptions := NodeSessionOptions{
			Frozen:             restoringOf(key),
			RetainCapabilities: true,
			Gate:               gate,
			Access:             access,
			Kernel:             options.Kernel,
			Catalog:            options.Catalog,
			GraphId:            graphId,
			NodeId:             nodeId,
			RevisionVersion:    revision.Version,
			Workspace:          workspace,
			InstancesDir:       options.InstancesDir,
			Bindings:           bindings,
		}
		if options.Library != nil {
			sessionOptions.Library = options.Library
		}
		if project := options.WorkspaceFor(graphId); project != nil {
			sessionOptions.ProjectRoot = *project
		}
		session := NodeSessionRequest(sessionOptions)
		if closing {
			if session.Close != nil {
				session.Close()
			}
			panic(errorString("Graph runtime is closing"))
		}
		session.Environment = &NodeSessionEnvironment{Revision: revisionVersion, Workspace: workspace, Base: location.Base, Access: access}
		session.SystemPrompt += "\n\nNODE WORKING ENVIRONMENT\n" + kernelGraphLaneJSON(kernelGraphLaneWorkingEnvironment{
			Workspace: workspace, Base: session.Environment.Base, Access: access,
		})
		if hasCached {
			previousWorkspace := (*string)(nil)
			if cached.Environment != nil {
				previousWorkspace = &cached.Environment.Workspace
			}
			previousDigest := (*string)(nil)
			if cached.Environment != nil && cached.Environment.Access != nil {
				previousDigest = &cached.Environment.Access.Digest
			}
			accessDigest := access.Digest
			options.Kernel.Store.Event(graphId, "graph.node.rebound", map[string]any{
				"nodeId": nodeId, "revision": revisionVersion,
				"previousRecipe": cached.Binding.DefinitionVersion, "recipe": session.Binding.DefinitionVersion,
				"previousWorkspace": previousWorkspace, "workspace": workspace,
				"previousAccessDigest": previousDigest, "accessDigest": accessDigest,
			})
		}
		setSession(key, session, configuration)
		if session.Operation != nil {
			RecordCapabilityLoad(options.Kernel.Store, NodeCapabilityLoadInput{
				TaskId: graphId, NodeId: nodeId, InstanceId: session.Binding.InstanceId,
				ReadOnly: false, Report: session.Operation.Report, Digest: session.BundleDigest,
				ToolPolicyDigest: session.ToolPolicyDigest, RuntimePolicyDigest: session.RuntimePolicyDigest,
			})
		}
		return session
	}

	lane := NewGraphLane(GraphLaneOptions{
		Kernel: options.Kernel,
		Finalize: func(graphId string) {
			if options.Git == nil || options.Kernel.Store.Task(graphId).IntegrationBranch == nil {
				return
			}
			options.Git.Exclusive(graphId, func() any {
				if closing || phaseClosed(options.Kernel.Store.Task(graphId).Phase) {
					return nil
				}
				acceptance := GraphAcceptance(options.Kernel, graphId, options.Artifacts)
				if !acceptance.Ready || acceptance.Commit == nil || *acceptance.Commit == "" {
					return nil
				}
				result := options.Git.TryDeliver(graphId, acceptance.Commit)
				if result.Status == "merged" {
					kernelExec(options.Kernel.Db, "INSERT INTO kernel_completion_delivery(task_id,commit_sha,created_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET commit_sha=excluded.commit_sha,created_at=excluded.created_at",
						graphId, *acceptance.Commit, NowMillis())
					return nil
				}
				options.Kernel.Store.Event(graphId, "graph.delivery.pending", map[string]any{
					"status": result.Status, "commit": *acceptance.Commit, "detail": result.Data,
				})
				return nil
			})
		},
		SettleWorkspace: func(executionId string) {
			execution := options.Kernel.Execution(executionId)
			if execution == nil || options.Git == nil || options.Kernel.Store.Task(execution.TaskId).IntegrationBranch == nil {
				return
			}
			options.Git.Exclusive(execution.TaskId, func() any {
				// The TypeScript check is ['stopping', 'stopped']; a completed task is
				// not a closed integration.
				phase := options.Kernel.Store.Task(execution.TaskId).Phase
				if closing || phase == "stopping" || phase == "stopped" {
					Raise("paused", "Git integration is closed")
				}
				revision := options.Kernel.Revision(execution.TaskId, execution.RevisionVersion)
				if revision == nil {
					return nil
				}
				node, ok := revision.Definition.Nodes[execution.NodeId]
				if !ok {
					return nil
				}
				known := options.Catalog.HasDefinition(node.Recipe)
				// Reviewer reports are shared artifacts; they must not become implementation changes.
				if known && options.Catalog.Definition(node.Recipe).Review {
					return nil
				}
				admitted := kernelGraphLaneAdmittedNode(options.Kernel, execution.TaskId, execution.NodeId)
				result := options.Git.Integrate(GitIntegrateInput{
					Id: execution.Id, TaskId: execution.TaskId, NodeId: execution.NodeId,
					InstanceId: &admitted.InstanceId, Kind: "agent", Recipe: node.Recipe,
				})
				if result != nil && !result.Ok {
					Raise("git_conflict", "Git integration refused: "+strings.Join(result.Conflicts, ", ")+
						". Inspect the worktree and integration tip before retrying.")
				}
				return nil
			})
		},
		Operation: func(graphId string, request ModuleOperationRequest) ModuleOperationResponse {
			execute := func() ModuleOperationResponse {
				workspace := options.WorkspaceFor(graphId)
				if options.Git != nil {
					if copy := options.Git.Workspace(graphId, nil, request.ModuleId, "program", "graph.command"); copy != nil {
						workspace = copy
					}
				}
				if workspace == nil {
					panic(errorString("Operation module has no workspace"))
				}
				program := &ModuleOperationProgram{}
				if options.Program != nil {
					program.ReadPaths = options.Program.ReadPaths
					program.Env = options.Program.Env
					program.NodeModulesPath = options.Program.NodeModulesPath
				}
				if program.NodeModulesPath == nil {
					base := *workspace
					if project := options.WorkspaceFor(graphId); project != nil {
						base = *project
					}
					modules := filepath.Join(base, "node_modules")
					program.NodeModulesPath = &modules
				}
				input := ModuleOperationInput{
					Kernel: options.Kernel, GraphId: graphId, ModuleId: request.ModuleId, DeliveryId: request.DeliveryId,
					RevisionVersion: request.RevisionVersion, Operation: request.Operation, Workspace: *workspace,
					ScratchRoot: options.StateDir, State: request.State, Inputs: request.Inputs, Signal: request.Signal,
					Program: program,
					// The same facts settleWorkspace uses decide whether this delivery's source owes the
					// integration branch a commit, so a check never waits on a source that never integrates.
					IntegratesSource: func(executionId string) bool {
						execution := options.Kernel.Execution(executionId)
						if execution == nil {
							return false
						}
						revision := options.Kernel.Revision(execution.TaskId, execution.RevisionVersion)
						if revision == nil {
							return false
						}
						node, ok := revision.Definition.Nodes[execution.NodeId]
						if !ok {
							return false
						}
						if options.Catalog.HasDefinition(node.Recipe) && options.Catalog.Definition(node.Recipe).Review {
							return false
						}
						admitted := kernelGraphLaneAdmittedNode(options.Kernel, execution.TaskId, execution.NodeId)
						return admitted.InstanceId != ""
					},
				}
				if options.Access != nil {
					input.Access = options.Access()
				}
				return ExecuteModuleOperation(input)
			}
			// A check observes one integration tip; managed merges cannot race its receipt.
			if options.Git != nil {
				return options.Git.Exclusive(graphId, func() any { return execute() }).(ModuleOperationResponse)
			}
			return execute()
		},
		CloseGraph: func(graphId string) {
			for _, key := range hostKeys() {
				if !strings.HasPrefix(key, graphId+"/") {
					continue
				}
				if host, ok := hostOf(key); ok {
					_ = host.Dispose()
				}
				if session, ok := forgetNode(key); ok && session.Close != nil {
					session.Close()
				}
			}
		},
		Close: func() {
			closing = true
			for _, key := range hostKeys() {
				if host, ok := hostOf(key); ok {
					_ = host.Dispose()
				}
				forgetHost(key)
			}
			for _, key := range sessionKeys() {
				session, ok := forgetNode(key)
				if ok && session.Close != nil {
					session.Close()
				}
			}
			resetLaneTables()
		},
		// A node's declared deliverable is settled from its own work copy into the shared
		// artifact store, so work the node produced is published without a tool call (§13.8).
		Workspace: func(graphId, nodeId string) *string {
			return nodeWorkspace(graphId, nodeId, nil)
		},
		Config: func(graphId, nodeId string, revisionVersion int) any {
			session := sessionFor(graphId, nodeId, revisionVersion)
			recipe := session.Binding.DefinitionVersion
			var model *ModelEntry
			if frozen := restoringOf(graphId + "/" + nodeId); frozen != nil {
				configuration := asMap(asMap(frozen["snapshot"])["configuration"])
				body, _ := json.Marshal(asMap(configuration["nodeExecutionConfiguration"])["model"])
				var entry ModelEntry
				if err := json.Unmarshal(body, &entry); err != nil {
					panic(err)
				}
				restoreDurableModelHeaders(configuration, &entry, options.Directory())
				model = &entry
			} else {
				model = ModelFor(options, recipe, &ModelForContext{GraphId: graphId, NodeId: nodeId, RevisionVersion: revisionVersion})
			}
			if model == nil {
				Raise("model_selection", "No eligible configured model for recipe "+recipe+"; review excludes recorded implementer models")
			}
			setBoundModel(graphId+"/"+nodeId, *model)
			credential := options.CredentialFor(*model)
			if credential == nil {
				panic(errorString("no credential bound for model " + model.Id))
			}
			workspace := session.StateDir
			if session.Environment != nil {
				workspace = session.Environment.Workspace
			}
			tools := []PiWorkerTool{}
			if session.Operation != nil {
				for _, tool := range session.Operation.Tools {
					tools = append(tools, PiWorkerTool{Name: tool.Name, Label: tool.Label, Description: tool.Description, Parameters: tool.Parameters})
				}
			}
			// §5: the node's graph output tool is `submit`. The host executes the call against the
			// real execution (HB-262), so the model can never forge an executionId.
			tools = append(tools, kernelGraphLaneSubmitTool())
			nativeTools := []string{}
			skillPaths := []string{}
			piExtensionPaths := []string{}
			piExtensionTools := []string{}
			mcpAdapterServers := []McpAdapterServerRef{}
			var skillFolder *string
			if session.Operation != nil {
				nativeTools = append(nativeTools, session.Operation.NativeTools...)
				skillPaths = append(skillPaths, session.Operation.SkillPaths...)
				piExtensionPaths = append(piExtensionPaths, session.Operation.PiExtensionPaths...)
				piExtensionTools = append(piExtensionTools, session.Operation.PiExtensionTools...)
				mcpAdapterServers = append(mcpAdapterServers, session.Operation.McpAdapterServers...)
				if session.Operation.SkillFolder != "" {
					folder := session.Operation.SkillFolder
					skillFolder = &folder
				}
			}
			cwds := []string{workspace}
			if project := options.WorkspaceFor(graphId); project != nil {
				cwds = append(cwds, *project)
			}
			skillPaths = append(skillPaths, NativeSkillDirs(cwds, "", "")...)
			seen := map[string]bool{}
			uniqueSkillPaths := []string{}
			for _, path := range skillPaths {
				if seen[path] {
					continue
				}
				seen[path] = true
				uniqueSkillPaths = append(uniqueSkillPaths, path)
			}
			allowedToolNames := []string{"submit"}
			for _, name := range session.AllowedToolNames {
				if name != "submit" {
					allowedToolNames = append(allowedToolNames, name)
				}
			}
			environment := kernelGraphLaneBindingEnvironment{Revision: revisionVersion}
			if session.Environment != nil {
				environment.Workspace = session.Environment.Workspace
				environment.Base = session.Environment.Base
				environment.Access = session.Environment.Access
			}
			kernelExec(options.Kernel.Db, "INSERT INTO kernel_node_bindings(task_id,node_id,model_id,system_prompt,tools,state_dir,role,environment) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,node_id) DO UPDATE SET model_id=excluded.model_id,system_prompt=excluded.system_prompt,tools=excluded.tools,state_dir=excluded.state_dir,role=excluded.role,environment=excluded.environment",
				graphId, nodeId, model.Id, session.SystemPrompt, kernelGraphLaneJSON(session.AllowedToolNames), session.StateDir, session.Role, kernelGraphLaneJSON(environment))
			compaction := CompactionSettingsFor(struct {
				ContextWindow int
				MaxTokens     int
			}{ContextWindow: model.ContextWindow, MaxTokens: model.MaxTokens})
			workerConfig := PiWorkerConfig{
				Binding: AgentSessionBinding{
					InstanceId: session.Binding.InstanceId, NodeId: session.Binding.NodeId, DefinitionVersion: session.Binding.DefinitionVersion,
				},
				AllowWorkspaceChange: true,
				Workspace:            workspace,
				StateDir:             session.StateDir,
				Model:                ToPiModel(*model),
				ThinkingLevel:        "off",
				Compaction:           &compaction,
				Tools:                tools,
				NativeTools:          nativeTools,
				SkillPaths:           uniqueSkillPaths,
				SkillFolder:          skillFolder,
				PiExtensionPaths:     piExtensionPaths,
				PiExtensionTools:     piExtensionTools,
				McpAdapterServers:    mcpAdapterServers,
				SystemPrompt:         session.SystemPrompt,
				AllowedToolNames:     allowedToolNames,
				BundleDigest:         session.BundleDigest,
				ToolPolicyDigest:     session.ToolPolicyDigest,
				RuntimePolicyDigest:  session.RuntimePolicyDigest,
			}
			execution := kernelRow(options.Kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
			if execution == nil {
				Raise("invalid_execution", "Node host has no admitted execution")
			}
			workerConfig.ExecutionId = graphDBString(execution, "id")
			workerConfig.DurableDatabase = options.Kernel.Store.Path
			body, _ := json.Marshal(workerConfig)
			_ = json.Unmarshal(body, &workerConfig.DurableRequest)
			policy := AgentSessionRequest{ReadRoots: session.Operation.ReadRoots, WriteRoots: session.Operation.WriteRoots, Env: session.Operation.Env, NetworkDomains: session.Operation.NetworkDomains, AllowUnrestrictedNetwork: session.Operation.AllowUnrestrictedNetwork, AllowLocalBinding: session.Operation.AllowLocalBinding, UnixSockets: session.Operation.UnixSockets}
			access := kernelGraphLaneAccess(session.Environment)
			if access != nil {
				if access.Filesystem.Read == "host" {
					policy.FilesystemAccess = "host"
				} else {
					policy.FilesystemAccess = "bounded"
				}
				policy.ProtectedPaths = access.ProtectedPaths
				policy.AllowGitMetadataWritesAll = access.Filesystem.GitMetadata == "writable"
				policy.AllowUnrestrictedNetwork = access.Network == "unrestricted"
				policy.AllowAllUnixSockets = access.PiExtensions.UnixSockets == "all"
				policy.AllowAppleEvents = access.PiExtensions.AppleEvents
			}
			workerConfig.DurableRequest["nodeExecutionConfiguration"] = map[string]any{"model": *model, "role": session.Role, "revision": revisionVersion, "base": environment.Base, "access": environment.Access}
			workerConfig.DurableRequest["credentialReference"] = map[string]any{"modelId": model.Id, "provider": model.Provider, "credentialId": model.CredentialId}
			workerConfig.DurableRequest["capabilityDescriptor"] = session.Operation.Descriptor
			workerConfig.DurableRequest["executionId"] = workerConfig.ExecutionId
			workerConfig.DurableRequest["readRoots"] = policy.ReadRoots
			workerConfig.DurableRequest["writeRoots"] = policy.WriteRoots
			workerConfig.DurableRequest["env"] = policy.Env
			workerConfig.DurableRequest["networkDomains"] = policy.NetworkDomains
			workerConfig.DurableRequest["allowUnrestrictedNetwork"] = policy.AllowUnrestrictedNetwork
			workerConfig.DurableRequest["allowLocalBinding"] = policy.AllowLocalBinding
			workerConfig.DurableRequest["unixSockets"] = policy.UnixSockets
			workerConfig.DurableRequest["allowAllUnixSockets"] = policy.AllowAllUnixSockets
			workerConfig.DurableRequest["allowAppleEvents"] = policy.AllowAppleEvents
			workerConfig.DurableRequest["filesystemAccess"] = policy.FilesystemAccess
			workerConfig.DurableRequest["protectedPaths"] = policy.ProtectedPaths
			workerConfig.DurableRequest["allowGitMetadataWritesAll"] = policy.AllowGitMetadataWritesAll
			if frozen := restoringOf(graphId + "/" + nodeId); frozen != nil {
				snapshot := asMap(frozen["snapshot"])
				configuration := asMap(snapshot["configuration"])
				policy := asMap(frozen["restoredPolicy"])
				for key, value := range policy {
					workerConfig.DurableRequest[key] = value
				}
				workerConfig.DurableRequest["model"] = snapshot["model"]
				workerConfig.DurableRequest["systemPrompt"] = mapString(asMap(snapshot["agent"]), "instructions")
				workerConfig.DurableRequest["nodeExecutionConfiguration"] = configuration["nodeExecutionConfiguration"]
				workerConfig.DurableRequest["credentialReference"] = configuration["credentialReference"]
				workerConfig.DurableRequest["capabilityDescriptor"] = frozen["restoredDescriptor"]
			}
			return workerConfig

		},
		// One resident process per node, reused across turns.
		Host: func(graphId, nodeId string, config any, revisionVersion int) ExecutorHost {
			key := graphId + "/" + nodeId
			cached, hasCached := hostOf(key)
			signature := CanonicalJSON(config)
			if hasCached && hostConfigOf(key) == signature {
				return &kernelGraphLaneHost{host: cached}
			}
			if hasCached {
				_ = cached.Stop()
			}
			session, hasSession := sessionOf(key)
			if !hasSession {
				panic(errorString("Resident host has no prepared session"))
			}
			if closing {
				panic(errorString("Graph runtime is closing"))
			}
			if session.Operation == nil {
				panic(errorString("Resident node has no resolved capability operation"))
			}
			workerConfig, ok := config.(PiWorkerConfig)
			if !ok {
				panic(errorString("Resident host has no prepared model connection"))
			}
			model, hasModel := boundModelOf(key)
			if !hasModel {
				panic(errorString("Resident host has no prepared model connection"))
			}
			if prepared, ok := workerConfig.Model.(piModelView); !ok || prepared.Name != model.Id {
				panic(errorString("Resident host has no prepared model connection"))
			}
			purpose := "completion"
			nativeGate := KernelToolGate(options.Kernel, graphId, nodeId, "tool", func() bool { return closing })
			nativeCalls := map[string]string{}
			host := NewResidentHost(ResidentHostOptions{
				DurableUsage: func() *ResidentTurnUsage {
					calls := options.Kernel.ProviderCalls(graphId, nodeId)
					usage := ResidentTurnUsage{}
					count := 0
					for _, call := range calls {
						if call.ExecutionId != workerConfig.ExecutionId {
							continue
						}
						count++
						if call.Usage == nil || (call.State != "settled" && call.State != "reconciled") {
							return nil
						}
						usage.Input += call.Usage.Input
						usage.Output += call.Usage.Output
						usage.CacheRead += call.Usage.CacheRead
						usage.CacheWrite += call.Usage.CacheWrite
						usage.Total += call.Usage.Input + call.Usage.Output + call.Usage.CacheRead + call.Usage.CacheWrite
					}
					if count == 0 {
						return nil
					}
					accounted := true
					usage.Accounted = &accounted
					return &usage
				},
				DurableInput: func() string {
					row := options.Kernel.Execution(workerConfig.ExecutionId)
					if row == nil {
						return ""
					}
					suffix := ""
					if row.ResubmitsUsed > 0 {
						suffix = fmt.Sprintf(":resubmit:%d", row.ResubmitsUsed)
					}
					return fmt.Sprintf("%s:attempt:%d%s", row.Id, row.Attempt, suffix)
				},
				Config: ResidentWorkerConfig{PiWorkerConfig: workerConfig, HostModel: true},
				OnTelemetry: func(call PiAdapterToolCall) {
					defer func() { _ = recover() }()
					options.Kernel.Store.RecordToolCall(ToolCallInput{InstanceID: session.Binding.InstanceId, Tool: call.Tool, Ms: call.Ms, IsError: call.IsError, Target: call.Target})
				},
				OnModelCall: func(raw any, hostSignal *AbortSignal, streamOptions WorkerModelOptions) (any, error) {
					credential := options.CredentialFor(model)
					if credential == nil {
						panic(errorString("Bound model credential unavailable"))
					}
					context, _ := raw.(map[string]any)
					if context == nil {
						panic(errorString("Invalid model context"))
					}
					if _, ok := context["messages"].([]any); !ok {
						panic(errorString("Invalid model context"))
					}
					usage := TokenUsage{}
					unknown := false
					var refusal *RuntimeError
					gate := KernelProviderGate(options.Kernel, graphId, nodeId, nil, &model, &ProviderRecipe{
						Definition: session.Binding.DefinitionVersion, Review: session.Role == "reviewer",
					}, purpose)
					observed := SendGate{
						Dispatch: func(id string, reservation float64, send func() any) any {
							defer func() {
								recovered := recover()
								if recovered == nil {
									return
								}
								if failure, ok := recovered.(*RuntimeError); ok && (failure.Code == "paused" || failure.Code == "budget") {
									refusal = failure
								}
								panic(recovered)
							}()
							return gate.Dispatch(id, reservation, send)
						},
						Settle: func(id string, cost *TokenUsage) {
							gate.Settle(id, cost)
							if cost == nil {
								unknown = true
								return
							}
							usage.Input += cost.Input
							usage.Output += cost.Output
							usage.CacheRead += cost.CacheRead
							usage.CacheWrite += cost.CacheWrite
						},
					}
					execution := kernelRow(options.Kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
					if execution == nil {
						panic(errorString("No active execution"))
					}
					executionID := graphDBString(execution, "id")
					abort := NewAbortSignal()
					cancel := func() { abort.Abort() }
					abortListener := hostSignal.AddEventListener("abort", cancel, true)
					unsubscribe := options.Kernel.Store.OnEvent(func(string) {
						if options.Kernel.Store.Task(graphId).Phase == "stopping" {
							abort.Abort()
						}
					})
					slot := kernelGraphLaneSlot(options, model, credential, executionID)
					defer func() {
						unsubscribe()
						hostSignal.RemoveEventListener(abortListener)
					}()
					stream, err := ControlledOpenAIStream(observed, model, func(candidate ModelEntry) string {
						binding := options.CredentialFor(candidate)
						if binding == nil {
							panic(errorString("Bound model credential unavailable"))
						}
						return binding.ApiKey
					}, slot, model.Api, PiAdapterStreamOptions{
						EstimateMissing: kernelGraphLaneUnlimited(options.Kernel, executionID),
						OnRequest: func(callId string, profile map[string]any) {
							// The TypeScript event spreads the profile into the event object,
							// so the profile's own keys sit beside callId and model.
							event := map[string]any{
								"callId": callId, "executionId": executionID, "nodeId": nodeId, "model": model.Id,
								"rates": model.Cost, "pricing": model.Pricing,
							}
							for name, value := range profile {
								event[name] = value
							}
							options.Kernel.Store.Event(graphId, "provider.request_profile", event)
						},
						OnSend: func(sent PiAdapterSentRequest) {
							tools := "[]"
							if sent.ToolDeclarations != nil {
								tools = kernelGraphLaneJSON(sent.ToolDeclarations)
							}
							kernelExec(options.Kernel.Db, "INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)",
								graphId, nodeId, executionID, rsiStringValue(sent.SystemPrompt), tools, NowMillis())
						},
					})(ToPiModel(model), context, kernelGraphLaneStreamOptions(streamOptions, abort))
					if err != nil {
						return nil, err
					}
					frames := EncodeAssistantStream(stream)
					settlement := stream.Result()
					// Provider SDKs wrap gate refusals as connection errors. Preserve the
					// host's control reason so pause cannot consume automatic retries.
					if refusal != nil && settlement["stopReason"] == "error" {
						settlement["errorMessage"] = refusal.Message
					}
					result := map[string]any{"frames": frames, "settlement": settlement}
					if !unknown {
						result["usage"] = map[string]any{
							"input": usage.Input, "output": usage.Output, "cacheRead": usage.CacheRead,
							"cacheWrite": usage.CacheWrite, "total": TokenUsageTotal(usage), "accounted": true,
						}
					}
					return result, nil
				},
				OnReady: func(inspect ResidentInspect) {
					RecordNodeSession(options.Kernel.Store, workerConfig.Binding.InstanceId, inspect.SessionId, inspect.SessionFile)
				},
				// The node's `submit` runs in the host, over the real execution (HB-262): the lane
				// wires that through `onToolCall` when it builds the runner.
				OnEvent: func(event any) {
					data, _ := event.(map[string]any)
					if data == nil {
						return
					}
					execution := kernelRow(options.Kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
					executionID := (*string)(nil)
					if execution != nil {
						value := graphDBString(execution, "id")
						executionID = &value
					}
					switch rsiText(data["type"]) {
					case "compaction_start":
						purpose = "compaction"
						options.Kernel.Store.Event(graphId, "session.compaction_started", map[string]any{"nodeId": nodeId, "operationId": executionID})
					case "compaction_end":
						purpose = "completion"
						result, _ := data["result"].(map[string]any)
						aborted, _ := data["aborted"].(bool)
						if !aborted && result != nil {
							summary := rsiText(result["summary"])
							AppendNodeEntry(options.Kernel.Store, NodeEntryInput{
								TaskID: graphId, NodeID: nodeId, OperationID: rsiStringValue(executionID),
								Role: "system", Kind: "compaction", Text: summary,
							})
							tokensBefore := (*int64)(nil)
							if value, ok := result["tokensBefore"].(float64); ok {
								converted := int64(value)
								tokensBefore = &converted
							}
							options.Kernel.Store.Event(graphId, "session.compacted", map[string]any{"nodeId": nodeId, "operationId": executionID, "tokensBefore": tokensBefore})
						} else {
							message := "compaction aborted"
							if text := rsiText(data["errorMessage"]); text != "" {
								message = text
							}
							options.Kernel.Store.Event(graphId, "session.compaction_failed", map[string]any{"nodeId": nodeId, "operationId": executionID, "error": message})
						}
					case "graph_provider_prompt":
						tools := "[]"
						if text, ok := data["tools"].(string); ok {
							tools = text
						} else if data["tools"] != nil {
							tools = kernelGraphLaneJSON(data["tools"])
						}
						kernelExec(options.Kernel.Db, "INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)",
							graphId, nodeId, rsiStringValue(executionID), rsiText(data["systemPrompt"]), tools, NowMillis())
					case "message_end":
						message, _ := data["message"].(map[string]any)
						if message == nil || rsiText(message["role"]) != "assistant" {
							break
						}
						text := kernelGraphLaneMessageText(message["content"])
						if text != "" {
							AppendNodeEntry(options.Kernel.Store, NodeEntryInput{
								TaskID: graphId, NodeID: nodeId, OperationID: rsiStringValue(executionID),
								Role: "assistant", Kind: "message", Text: text,
							})
						}
					case "tool_execution_start", "tool_execution_end":
						call := rsiText(data["type"]) == "tool_execution_start"
						reason := ""
						if !call {
							if failed, ok := data["isError"].(bool); ok && failed {
								reason = ToolResultText(data["result"], 0)
							}
						}
						text := ""
						if reason != "" {
							runes := []rune(reason)
							if len(runes) > 400 {
								runes = runes[:400]
							}
							text = "工具执行失败：" + string(runes)
						} else if call {
							text = kernelGraphLaneJSON(kernelGraphLaneToolCall{Name: rsiText(data["toolName"]), Args: data["args"]})
						} else {
							text = kernelGraphLaneJSON(data["result"])
						}
						entryData := map[string]any{
							"toolName": rsiText(data["toolName"]), "toolCallId": rsiText(data["toolCallId"]), "isError": data["isError"],
						}
						if reason != "" {
							entryData["message"] = reason
						}
						AppendNodeEntry(options.Kernel.Store, NodeEntryInput{
							TaskID: graphId, NodeID: nodeId, OperationID: rsiStringValue(executionID),
							Role: "tool", Kind: map[bool]string{true: "call", false: "result"}[call], Text: text, Data: entryData,
						})
					}
				},
				OnToolCall: func(name string, args any) (ResidentToolAnswer, error) {
					if name == "native_tool_start" || name == "native_tool_settle" {
						call, _ := args.(map[string]any)
						if call == nil {
							return ResidentToolAnswer{Ok: false, Text: "Unknown native tool admission"}, nil
						}
						callID := rsiText(call["id"])
						if callID == "" {
							return ResidentToolAnswer{Ok: false, Text: "Unknown native tool admission"}, nil
						}
						toolName := rsiText(call["name"])
						admitted := false
						for _, candidate := range append(append([]string{}, session.Operation.NativeTools...), session.Operation.PiExtensionTools...) {
							if candidate == toolName {
								admitted = true
								break
							}
						}
						if !admitted {
							return ResidentToolAnswer{Ok: false, Text: "Unknown native tool admission"}, nil
						}
						if name == "native_tool_start" {
							if _, ok := nativeCalls[callID]; ok {
								return ResidentToolAnswer{Ok: false, Text: "Native tool already admitted"}, nil
							}
							id := graphUUID()
							nativeGate.Dispatch(id, 0, func() any { return nil })
							nativeCalls[callID] = id
						} else {
							id, ok := nativeCalls[callID]
							if !ok {
								return ResidentToolAnswer{Ok: false, Text: "Native tool has no admission"}, nil
							}
							nativeGate.Settle(id, &TokenUsage{})
							delete(nativeCalls, callID)
						}
						return ResidentToolAnswer{Ok: true, Text: "ok"}, nil
					}
					var tool *ToolDefinition
					if session.Operation != nil {
						for index, candidate := range session.Operation.Tools {
							if candidate.Name == name {
								tool = &session.Operation.Tools[index]
								break
							}
						}
					}
					if tool == nil {
						if options.OnToolCall != nil {
							return options.OnToolCall(graphId, nodeId, name, args), nil
						}
						return ResidentToolAnswer{Ok: false, Text: "the host does not offer a tool named " + name}, nil
					}
					id := graphUUID()
					result := nativeGate.Dispatch(id, 0, func() any {
						defer nativeGate.Settle(id, &TokenUsage{})
						if tool.Execute == nil {
							return nil
						}
						value, executeErr := tool.Execute(id, args)
						if executeErr != nil {
							return executeErr
						}
						return value
					})
					if failure, ok := result.(error); ok {
						return ResidentToolAnswer{Ok: false, Text: failure.Error()}, nil
					}
					failed := false
					if record, ok := result.(map[string]any); ok {
						// The TypeScript test is `'isError' in result && result.isError`, so a
						// present but false flag is not a failure.
						if value, isError := record["isError"]; isError && kernelGraphLaneTruthy(value) {
							failed = true
						}
					}
					return ResidentToolAnswer{Ok: !failed, Text: kernelGraphLaneJSON(result)}, nil
				},
			})
			setHost(key, host, signature)
			return &kernelGraphLaneHost{host: host}
		},
	})
	if options.TokenBudget != nil && options.ReserveTokens != nil {
		lane.options.TokenBudget = options.TokenBudget
		lane.options.ReserveTokens = options.ReserveTokens
	}
	if options.Artifacts != nil {
		lane.options.Artifacts = func(graphId string) *ArtifactWorkspace { return options.Artifacts }
	}
	registerDurableNodeResolver(options.Kernel.Store.Path, func(wrapper map[string]any) (*DurableRecoveryBinding, error) {
		snapshot := asMap(wrapper["snapshot"])
		id := mapString(snapshot, "executionId")
		execution := options.Kernel.Execution(id)
		if execution == nil {
			return nil, nil
		}
		if mapString(asMap(asMap(snapshot["configuration"])["policy"])["binding"].(map[string]any), "instanceId") != mapString(snapshot, "identity") {
			return nil, fmt.Errorf("Frozen node identity mismatch")
		}
		key := execution.TaskId + "/" + execution.NodeId
		setRestoring(key, wrapper)
		originalState := execution.State
		kernelExec(options.Kernel.Db, "UPDATE kernel_executions SET state='running' WHERE id=?", id)
		defer kernelExec(options.Kernel.Db, "UPDATE kernel_executions SET state=? WHERE id=?", originalState, id)
		config := lane.options.Config(execution.TaskId, execution.NodeId, execution.RevisionVersion)
		adapter := lane.options.Host(execution.TaskId, execution.NodeId, config, execution.RevisionVersion).(*kernelGraphLaneHost)
		host := adapter.host
		return &DurableRecoveryBinding{Config: host.options.Config.DurableRequest, Callback: func(kind string, params map[string]any) (any, error) {
			if kind == "model" || kind == "tool" || kind == "native_gate" {
				for {
					if closing {
						return nil, fmt.Errorf("Original node owner is closing")
					}
					row := options.Kernel.Execution(id)
					task := options.Kernel.Store.Task(execution.TaskId)
					if row == nil || phaseClosed(task.Phase) {
						return nil, fmt.Errorf("Original node execution is closed")
					}
					if row.State == "running" && task.Paused == 0 && !options.Kernel.NodeState(execution.TaskId, execution.NodeId).Paused {
						break
					}
					time.Sleep(20 * time.Millisecond)
				}
			}
			return host.durableCallback()(kind, params)
		}, Close: func() { _ = host.Dispose() }}, nil
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
			SetNativeExecutionWaiting(options.Kernel.Store, executionId, true)
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
					SetNativeExecutionWaiting(options.Kernel.Store, executionId, false)
					panic(recovered)
				}
			}()
			for {
				before := request()
				acquired, err := options.Scheduler.Acquire(before, signal)
				if err != nil {
					SetNativeExecutionWaiting(options.Kernel.Store, executionId, false)
					return nil, err
				}
				after := request()
				if before.CredentialId == after.CredentialId && before.ApiKey == after.ApiKey {
					release = acquired
					break
				}
				acquired()
			}
			WaitForKernelExecutionSlot(options.Kernel.Store, executionId, signal)
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
