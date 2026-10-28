package graph

import (
	"strings"

	"fmt"
)

// sessionFor assembles the node's session: the resident process, the
// bound model and the tools the turn may call.
func (state *kernelGraphLaneState) sessionFor(graphId, nodeId string, revisionVersion int) NodeSession {
	if state.closing.Load() {
		panic(errorString("Graph runtime is state.closing.Load()"))
	}
	key := graphId + "/" + nodeId
	if frozen := state.restoring.Get(key); frozen != nil {
		active := state.options.Kernel.RunningExecution(graphId, nodeId)
		if active != nil && active.Id != frozen.Record.ExecutionId {
			state.restoring.Delete(key)
		}
	}
	cached, hasCached := state.sessions.Lookup(key)
	revision := state.options.Kernel.Revision(graphId, revisionVersion)
	if revision == nil {
		panic(errorString(fmt.Sprintf("graph %s has no revision to run", graphId)))
	}
	recipe := ""
	if node, ok := revision.Definition.Nodes[nodeId]; ok {
		recipe = node.Recipe
	}
	role := "worker"
	if frozen := state.restoring.Get(key); frozen != nil {
		role = mapString(asMap(frozen.Record.Configuration.ExecutionConfiguration), "role")
	} else if recipe != "" && state.options.Catalog.Definition(recipe).Review {
		role = "reviewer"
	}
	// A node may replace the prompt texts it runs under. That is how one
	// task runs under several harnesses at once: the harness is the
	// difference between the candidates, the task is what they all answer.
	library := state.options.Library
	if node, ok := revision.Definition.Nodes[nodeId]; ok && len(node.Harness) > 0 {
		library = state.options.Library.WithOverlay(node.Harness)
	}
	var prompts []string
	if library != nil && state.restoring.Get(key) == nil {
		definitionID := nodeId
		if recipe != "" {
			definitionID = strings.Split(recipe, "@")[0]
		}
		common, err := state.options.Library.Prompt("rules/common.md")
		if err != nil {
			panic(err)
		}
		rules, err := library.Prompt("rules/" + role + ".md")
		if err != nil {
			panic(err)
		}
		tools, err := library.Prompt("tools/" + role + ".md")
		if err != nil {
			panic(err)
		}
		runtime, err := library.Prompt("runtime/node.md")
		if err != nil {
			panic(err)
		}
		identity := library.AgentPrompt(definitionID, nil)
		prompts = []string{common, rules, tools, runtime, identity}
	}
	location := state.nodeLocation(graphId, nodeId, &revisionVersion, true)
	if location == nil {
		Raise("invalid_workspace", fmt.Sprintf("graph %s node %s has no workspace", graphId, nodeId))
	}
	workspace := location.Workspace
	access := state.nodeAccess(graphId, nodeId, revisionVersion)
	conversation := SupervisorConversationForTask(state.options.Kernel.Store, graphId)
	owner := ""
	if conversation != nil {
		owner = conversation.AnchorTaskId
	}
	configuration := CanonicalJSON(map[string]any{
		"recipe": recipe, "prompts": prompts, "workspace": workspace, "access": access, "network": state.options.Network, "supervisor": owner,
	})
	if hasCached && state.sessionRevisions.Get(key) == configuration {
		return cached
	}
	if hasCached {
		if host, ok := state.hosts.Lookup(key); ok {
			_ = host.Stop()
		}
		state.hosts.Delete(key)
		if cached.Close != nil {
			cached.Close()
		}
	}
	domains := []string{}
	if state.options.Network != nil {
		domains = state.options.Network.RetrievalDomains
	}
	unrestricted := access.Network == "unrestricted"
	var retrieval *RetrievalBroker
	if len(domains) > 0 || unrestricted {
		retrieval = CreateRetrievalBroker(domains, KernelToolGate(state.options.Kernel, graphId, nodeId, "retrieval", func() bool { return state.closing.Load() }), unrestricted, 0, 0)
	}
	var gate *SendGate
	if state.options.GateFor != nil {
		gate = state.options.GateFor(graphId, nodeId)
	}
	if gate == nil {
		tool := KernelToolGate(state.options.Kernel, graphId, nodeId, "tool", func() bool { return state.closing.Load() })
		gate = &tool
	}
	bindings := &NodeSessionBindings{}
	if conversation != nil && conversation.Role == ConversationProject {
		bindings.AskSupervisor = func(question PiAdapterAskedQuestion) {
			state.options.Kernel.RecordNodeQuestion(graphId, nodeId, question)
		}
		// A notice reaches the global supervisor's thread directly; it is not a
		// node question and nothing in this graph waits for it.
		bindings.NotifySupervisor = func(notice PiAdapterSupervisorNotice) any {
			return RecordSupervisorNotice(state.options.Kernel.Store, graphId, SupervisorNotice{
				Text: notice.Text, Milestone: notice.Milestone, Evidence: notice.Evidence, RequestID: notice.RequestID,
			})
		}
	}
	if retrieval != nil {
		broker := retrieval
		bindings.Fetch = func(url string, signal *AbortSignal) RetrievalResult {
			return broker.Fetch(url, signal)
		}
	}
	if state.options.Git != nil && state.options.Kernel.Store.Task(graphId).IntegrationBranch != nil && location.Base == "worktree" && role != "reviewer" {
		bindings.CommitWorkspace = func(paths []string, message string) any {
			return state.options.Git.Exclusive(graphId, func() any {
				task := state.options.Kernel.Store.Task(graphId)
				execution := state.options.Kernel.RunningExecution(graphId, nodeId)
				if execution == nil || state.closing.Load() || task.Paused != 0 || state.options.Kernel.NodeState(graphId, nodeId).Paused || phaseClosed(task.Phase) {
					Raise("paused", "Workspace commit is closed")
				}
				if state.options.Kernel.HasUnknownProviderCall(graphId, nodeId) {
					row := state.options.Kernel.Execution(execution.Id)
					if row == nil || row.TokenBudget == nil || !row.TokenBudget.Unlimited {
						Raise("budget", "Reconcile unknown provider usage before committing work")
					}
				}
				admitted := kernelGraphLaneAdmittedNode(state.options.Kernel, graphId, nodeId)
				return state.options.Git.CommitWorkspace(GitCommitInput{
					Id: execution.Id, TaskId: graphId, NodeId: nodeId, InstanceId: admitted.InstanceId,
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
			latest := state.options.Kernel.LatestRevision(graphId)
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
				if state.options.OnMainMessage == nil {
					panic(errorString("Main agent message channel unavailable"))
				}
				return state.options.OnMainMessage(graphId, nodeId, request.Text, request.RequestId)
			}
			return SendKernelNodeMessage(state.options.Kernel, graphId, request.To, NodeMessageInput{Text: request.Text, RequestID: request.RequestId}, &nodeId)
		},
	}
	if state.options.Artifacts != nil {
		artifacts := state.options.Artifacts
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
				execution := state.options.Kernel.RunningExecution(graphId, nodeId)
				if execution == nil {
					panic(errorString("No active execution"))
				}
				admitted := kernelGraphLaneAdmittedNode(state.options.Kernel, graphId, nodeId)
				return artifacts.Retire(graphId, id, version, reason, requestId, ArtifactProducer{
					NodeId: nodeId, InstanceId: admitted.InstanceId, OperationId: execution.Id, ActivationId: execution.Id,
				})
			},
			Publish: func(input PublishArtifactInput) ArtifactRecord {
				execution := state.options.Kernel.RunningExecution(graphId, nodeId)
				if execution == nil {
					panic(errorString("No active execution"))
				}
				admitted := kernelGraphLaneAdmittedNode(state.options.Kernel, graphId, nodeId)
				published := input
				published.TaskId = graphId
				published.Workspace = workspace
				published.Producer = ArtifactProducer{
					NodeId: nodeId, InstanceId: admitted.InstanceId, OperationId: execution.Id, ActivationId: execution.Id,
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
		Frozen:             state.restoring.Get(key),
		RetainCapabilities: true,
		Gate:               gate,
		Access:             access,
		Kernel:             state.options.Kernel,
		Catalog:            state.options.Catalog,
		GraphId:            graphId,
		NodeId:             nodeId,
		RevisionVersion:    revision.Version,
		Workspace:          workspace,
		InstancesDir:       state.options.InstancesDir,
		Bindings:           bindings,
		// The PiG kernel has no SDK of its own, so the daemon provides the
		// native tools the TypeScript SDK used to publish.
		DaemonNativeTools: true,
	}
	if library != nil {
		sessionOptions.Library = library
	}
	if project := state.options.WorkspaceFor(graphId); project != nil {
		sessionOptions.ProjectRoot = *project
	}
	session := NodeSessionRequest(sessionOptions)
	if state.closing.Load() {
		if session.Close != nil {
			session.Close()
		}
		panic(errorString("Graph runtime is state.closing.Load()"))
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
		state.options.Kernel.Store.Event(graphId, "graph.node.rebound", map[string]any{
			"nodeId": nodeId, "revision": revisionVersion,
			"previousRecipe": cached.Binding.DefinitionVersion, "recipe": session.Binding.DefinitionVersion,
			"previousWorkspace": previousWorkspace, "workspace": workspace,
			"previousAccessDigest": previousDigest, "accessDigest": accessDigest,
		})
	}
	state.sessions.Store(key, session)
	state.sessionRevisions.Store(key, configuration)
	if session.Operation != nil {
		RecordCapabilityLoad(state.options.Kernel.Store, NodeCapabilityLoadInput{
			TaskId: graphId, NodeId: nodeId, InstanceId: session.Binding.InstanceId,
			ReadOnly: false, Report: session.Operation.Report, Digest: session.BundleDigest,
			ToolPolicyDigest: session.ToolPolicyDigest, RuntimePolicyDigest: session.RuntimePolicyDigest,
		})
	}
	return session
}
