package graph

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
)

func piAdapterRunOperation(options PiAdapterOptions, transport AgentSessionTransport, input piAdapterRunInput) OperationResult {
	operation := input.Operation
	entry := input.Entry
	store := options.Store
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
	nodeId := operation.NodeId
	gate := TaskGate(store, TaskGateOperation{
		Id: operation.Id, TaskId: operation.TaskId, InstanceId: instanceId, NodeId: &nodeId,
	}, entry, TaskGateOptions{Unrestricted: input.FullAccess})
	// A pre-send gate refusal (pause, budget, unknown usage) surfaces as an
	// error inside the Pi session; keep it so the operation is not recorded
	// as a success with zero provider requests.
	var gateRefusal error
	observedGate := SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any {
			sending := false
			defer func() {
				if rec := recover(); rec != nil {
					if !sending {
						gateRefusal = asError(rec)
					}
					panic(rec)
				}
			}()
			return gate.Dispatch(id, reservation, func() any {
				sending = true
				return send()
			})
		},
		Settle: func(id string, usage *TokenUsage) { gate.Settle(id, usage) },
	}
	specRow, ok := graphDBRow(store.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
	if !ok {
		Raise("not_found", "No node for this operation")
	}
	var spec NodeSpec
	if err := json.Unmarshal([]byte(graphDBString(specRow, "spec")), &spec); err != nil {
		panic(err)
	}
	if options.RecoverySnapshot != nil {
		configuration := options.RecoverySnapshot.Record.Configuration
		body, _ := json.Marshal(asMap(configuration.ExecutionConfiguration)["spec"])
		if err := json.Unmarshal(body, &spec); err != nil {
			panic(err)
		}
	}
	var conversation *ConversationRow
	if input.Task.Phase == "chatting" {
		conversation = ConversationForTask(store, operation.TaskId)
	}
	workspace := piAdapterRealpath(input.ProjectRoot)
	if operation.Workspace != nil && *operation.Workspace != "" {
		workspace = piAdapterRealpath(*operation.Workspace)
	}
	var permissionRequest *CapabilityPermissionRequest
	var askedQuestion *PiAdapterAskedQuestion
	var reloadReceipt map[string]any
	channels := options.Channels
	var agentPromptLibrary *AgentContextLibrary
	if channels != nil {
		agentPromptLibrary = channels.AgentContext
	}
	role := ""
	if spec.Role != nil {
		role = *spec.Role
	}
	systemDomains := []string{}
	if role == "master" {
		systemDomains = []string{"github.com", "raw.githubusercontent.com", "api.github.com"}
	}
	retrievalDomains := []string{}
	if options.Network != nil {
		retrievalDomains = append(retrievalDomains, options.Network.RetrievalDomains...)
	}
	retrievalDomains = append(retrievalDomains, systemDomains...)
	retrievalDomains = piAdapterUnique(retrievalDomains)
	unrestrictedRetrieval := input.AccessPolicy != nil && input.AccessPolicy.Network == "unrestricted"
	var retrieval *RetrievalBroker
	if len(retrievalDomains) > 0 || unrestrictedRetrieval {
		retrieval = CreateRetrievalBroker(retrievalDomains, observedGate, unrestrictedRetrieval, 0, 0)
	}
	artifactService := piAdapterArtifactService(options, input, spec, workspace, role)

	var capabilityOperation CapabilityOperation
	var commands *WorkspaceCommandRunner
	var contextAssembly *AgentContextAssembly
	var setupError error
	setupFailed := func(err error) OperationResult {
		if commands != nil {
			commands.Close()
		}
		return OperationResult{
			Outcome: "failed",
			Output:  map[string]any{"setupError": err.Error()},
			Usage:   &TokenUsage{},
		}
	}
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				capabilityOperation = CapabilityOperation{}
				commands = nil
				setupError = asError(rec)
			}
		}()
		definitionId := ""
		if strings.Contains(input.DefinitionVersion, "@") {
			definitionId = strings.Split(input.DefinitionVersion, "@")[0]
		}
		skillCapabilityRoot := ""
		if options.Catalog != nil {
			skillCapabilityRoot = options.Catalog.CapabilityRootPath()
		}
		assemblyInput := AgentContextAssemblyOptions{
			CapabilityBundleOptions: CapabilityBundleOptions{
				Catalog: options.Catalog, DefinitionVersion: input.DefinitionVersion,
				SkillProjectRoot: input.ProjectRoot,
			},
			Action: spec.Action, Role: role, Runtime: "worker", Workspace: workspace,
			FullAccess: input.FullAccess, Retrieval: retrieval != nil,
			Rsi: channels != nil && channels.Rsi != nil && channels.Rsi.Available && role == "master" && input.FullAccess,
		}
		if agentPromptLibrary != nil {
			assemblyInput.Library = agentPromptLibrary
		}
		if channels != nil {
			if definitionId != "" && channels.BootstrapPrompts != nil {
				if prompt, ok := channels.BootstrapPrompts[definitionId]; ok && prompt != "" {
					assemblyInput.Bootstrap = &CapabilityBootstrap{Agent: prompt}
				}
			}
			if channels.BootstrapToolPrompt != nil {
				if assemblyInput.Bootstrap == nil {
					assemblyInput.Bootstrap = &CapabilityBootstrap{}
				}
				assemblyInput.Bootstrap.Tool = *channels.BootstrapToolPrompt
			}
		}
		if options.Network != nil && len(options.Network.McpDomains) > 0 {
			assemblyInput.McpDomains = options.Network.McpDomains
		}
		if options.CapabilitySecrets != nil {
			assemblyInput.Secrets = options.CapabilitySecrets
		}
		if definitionId != "" && skillCapabilityRoot != "" {
			assemblyInput.SkillFolder = AgentSkillsDir(definitionId, filepath.Dir(skillCapabilityRoot))
			assemblyInput.SkillOwnedRoots = AgentSkillOwnedRoots(skillCapabilityRoot, filepath.Dir(options.InstancesDir))
		}
		if options.RecoverySnapshot != nil {
			descriptor := options.RecoverySnapshot.Descriptor
			body, _ := json.Marshal(descriptor["facts"])
			facts := []ResolvedCapabilityFact{}
			if err := json.Unmarshal(body, &facts); err != nil {
				panic(err)
			}
			assemblyInput.FrozenFacts = facts
			assemblyInput.SkillFolder = ""
		}
		if role == "master" && options.Artifacts != nil {
			// The main Agent is the one that improves the harness, so it is the
			// one that starts with what earlier runs learned.
			assemblyInput.ExperienceContext = harnessExperiencePrompt(options.Artifacts, operation.TaskId)
		}
		contextAssembly = OpenAgentContextAssembly(assemblyInput)
		capabilityRoot := ""
		if role == "master" && options.Catalog != nil && options.Catalog.CapabilityRootPath() != "" {
			capabilityRoot = piAdapterOptionalRealpath(options.Catalog.CapabilityRootPath())
		}
		graphRoot := ""
		if role == "master" {
			graphRoot = piAdapterOptionalRealpath(GraphApplicationRoot())
		}
		masterReadRoots := []string{}
		if role == "master" {
			for _, path := range []string{capabilityRoot, graphRoot, agentContextRoot(agentPromptLibrary)} {
				if path != "" {
					masterReadRoots = append(masterReadRoots, path)
				}
			}
			masterReadRoots = piAdapterUnique(masterReadRoots)
		}
		// The work copy is dependency-free on disk; the project's own install
		// is linked in and granted to the sandbox so a worker command resolves
		// the project toolchain the way it would in the project root.
		dependencies := LinkProjectDependencies(workspace, nil)
		commandReadPaths := []string(nil)
		if dependencies != nil {
			commandReadPaths = []string{*dependencies}
		}
		commands = OpenWorkspaceCommandRunner(
			workspace,
			filepath.Join(options.InstancesDir, instanceId, "command-scratch"),
			observedGate,
			commandReadPaths,
			nil,
			false,
			input.AccessPolicy,
			false,
			0,
		)
		operationInput := CapabilityOperationOptions{
			Workspace:           workspace,
			ScratchDir:          filepath.Join(options.InstancesDir, instanceId, "capability-scratch"),
			Gate:                observedGate,
			Action:              spec.Action,
			Role:                role,
			NativeTools:         PiNativeToolNamesForPlatform(),
			Access:              input.AccessPolicy,
			Grants:              operation.Grants,
			DisabledTools:       contextAssembly.DisabledTools,
			AdditionalReadRoots: masterReadRoots,
			OnPermissionRequired: func(request CapabilityPermissionRequest) {
				if permissionRequest == nil {
					copied := request
					permissionRequest = &copied
				}
			},
		}
		// The native tools of the PiG kernel are the daemon's own: the kernel owns
		// no environment, so the tools the SDK used to provide are built here.
		var nativeToolInput *AgentToolsInput
		operationInput.HostTools = func(readRoots []string) []ToolDefinition {
			tools := AgentToolsInput{
				Workspace: workspace, Role: role, ReadRoots: append([]string{}, readRoots...), Catalog: options.Catalog,
				Access: input.AccessPolicy,
				Run: func(command string, args []string, signal *AbortSignal) CommandResult {
					return commands.Run(command, args, signal)
				},
			}
			built := tools
			nativeToolInput = &built
			if role != "" {
				tools.Role = role
			}
			// The tool surface records the agent's own question here; the capability
			// layer above knows nothing about it.
			if conversation == nil || conversation.Role != ConversationProject {
				tools.OnAskUser = func(request PiAdapterAskedQuestion) {
					if askedQuestion == nil {
						copied := request
						askedQuestion = &copied
					}
				}
			} else if role == "master" && conversation.AnchorTaskId == operation.TaskId {
				tools.OnAskSupervisor = func(request PiAdapterAskedQuestion) {
					if askedQuestion == nil {
						request.ToSupervisor = true
						askedQuestion = &request
					}
				}
			}
			if retrieval != nil {
				tools.Fetch = func(url string, signal *AbortSignal) RetrievalResult {
					return retrieval.Fetch(url, signal)
				}
			}
			if artifactService != nil {
				tools.Artifacts = artifactService
			}
			// A graph node may talk to the other Agents of its OWN graph. The reach rule is the
			// graph itself: a node of another graph is not a peer, so naming one is refused.
			if role != "master" && channels != nil && channels.Peers != nil {
				peers := channels.Peers(operation.TaskId)
				tools.Peers = PiAdapterPeerTools{
					List: func() []PiAdapterPeerNode {
						nodes := []PiAdapterPeerNode{}
						for _, node := range PeerNodes(store, operation.TaskId) {
							nodes = append(nodes, PiAdapterPeerNode{Id: node.Id, Role: node.Role, Status: node.Status})
						}
						return nodes
					},
					Send: func(request PiAdapterPeerRequest) any {
						if peers.Deliver == nil {
							panic(errors.New("This Agent session has no graph peers"))
						}
						return peers.Deliver(operation.NodeId, PiAdapterPeerDelivery{To: request.To, Text: request.Text, RequestId: request.RequestId})
					},
				}
			}
			// A master session may hand work to any other conversation. The rules and the handoff
			// ledger live in `conversation-tools.ts`.
			if channels != nil && channels.Conversations != nil && conversation != nil && role == "master" {
				tools.Conversations = OpenConversationTools(
					*channels.Conversations,
					ConversationToolCaller{ConversationID: conversation.Id, TaskID: operation.TaskId, NodeID: operation.NodeId},
					input.AccessPolicy != nil && IsFullAccess(input.AccessPolicy),
					func(record map[string]any) { store.Event(operation.TaskId, "conversation.handed_off", record) },
				)
			}
			if channels != nil {
				supervisor := channels.Supervisor(operation.TaskId)
				tools.Supervisor = supervisor
				tools.ControlTask = supervisor.ControlTask
				// The TypeScript supervisor carries the graph control surface, so
				// the graph tools read it from the same place.
				tools.GraphManagement = supervisor.GraphManagement
				tools.Catalog = channels.Catalog
			}
			// The self-improvement tools change the Graph source checkout, so they
			// belong to the master alone and only to a session that may act on the
			// host. The status stays available without a checkout - it names the
			// reason there is none - while an apply needs one to change.
			if channels != nil && channels.Rsi != nil && role == "master" && input.FullAccess {
				tools.Rsi = &AgentToolsRsi{Status: channels.Rsi.Status}
				if channels.Rsi.Available {
					tools.Rsi.Apply = channels.Rsi.Apply
				}
				rsiContext := PiAdapterRsiContext{TaskId: operation.TaskId, OperationId: &operation.Id}
				if conversation != nil {
					conversationId := conversation.Id
					rsiContext.ConversationId = &conversationId
				}
				tools.RsiContext = rsiContext
			}
			// The system tools belong to the master alone: they tell it what the
			// host looks like, and they are the only ones that may ask for a
			// change to the host itself.
			if channels != nil && channels.SystemContext != nil && role == "master" {
				tools.SystemContext = &AgentToolsSystemContext{
					SystemSummary: channels.SystemContext.SystemSummary,
					SystemDiagnostics: func() map[string]any {
						scope := []string{operation.TaskId}
						conversationId := ""
						if conversation != nil {
							conversationId = conversation.Id
							scope = systemChangeScope(store, conversation, operation.TaskId)
						}
						return SystemDiagnostics(SystemDiagnosticsInput{
							Store: store, Catalog: options.Catalog, TaskIds: scope, ConversationId: conversationId,
						})
					},
					ProposeSystemChange: func(change AgentToolsSystemChange) map[string]any {
						return ProposeSystemChange(store, operation.TaskId, operation.NodeId, input.AccessPolicy, SystemChangeProposal{
							Title: change.Title, Problem: change.Problem, Change: change.Change,
							Impact: change.Impact, Risk: change.Risk,
						})
					},
					ApplySystemChange: func(proposalId string) map[string]any {
						return ApplySystemChange(store, options.Catalog, operation.TaskId, operation.NodeId, proposalId)
					},
				}
			}
			return AgentTools(tools)
		}
		operationInput.NativeToolsProvider = func(granted []string) []ToolDefinition {
			if nativeToolInput == nil || !options.DaemonNativeTools {
				return nil
			}
			return PigNativeTools(*nativeToolInput, granted)
		}
		capabilityOperation = contextAssembly.Bundle.OpenOperation(operationInput)
	}()
	if setupError != nil {
		return setupFailed(setupError)
	}
	defer func() {
		if capabilityOperation.Close != nil {
			capabilityOperation.Close()
		}
		if commands != nil {
			commands.Close()
		}
	}()

	tools := append([]ToolDefinition{}, capabilityOperation.Tools...)
	// A stored level can predate a catalog refresh, or name a model the
	// snapshot does not list: clamp it to a level this model accepts before
	// the turn runs, using the same SDK rule the console displays.
	//
	// An operation without a conversation is a graph node: it has no stored
	// level of its own, and running it without reasoning is not what its model
	// was made for. It runs at the level the model accepts by default.
	thinkingLevel := "off"
	if conversation != nil && conversation.ThinkingLevel != nil {
		thinkingLevel = *conversation.ThinkingLevel
	} else {
		thinkingLevel = string(EffectiveThinkingLevel(entry, nil))
	}
	model := ToPiModel(entry)
	thinkingLevel = clampThinkingLevel(model.Reasoning, model.ThinkingLevelMap, thinkingLevel)
	modelPolicyDigest := contextDigest(map[string]any{
		"id":            entry.Id,
		"modelId":       piAdapterNullableString(entry.ModelId),
		"provider":      entry.Provider,
		"api":           string(entry.Api),
		"baseUrl":       entry.BaseUrl,
		"contextWindow": entry.ContextWindow,
		"maxTokens":     entry.MaxTokens,
		"thinkingLevel": thinkingLevel,
	})
	toolPolicyDigest := capabilityOperation.ToolPolicyDigest
	composedPrompt := contextAssembly.ForOperation(capabilityOperation).Composed.Text
	if conversation != nil && role == "master" {
		switch conversation.Role {
		case ConversationGlobal:
			composedPrompt += "\n\nYou are the global supervisor. You coordinate all projects and do not bind this conversation to one project. Clarify the user's project, goal, and acceptance before calling delegate_work. When notified that a project draft is ready, use read_work_draft to review it and tell the user what is ready. Explain issues yourself first; ask the user only when you cannot resolve them."
		case ConversationProject:
			composedPrompt += "\n\nYou are the long-lived project supervisor. Manage work delegated by the global supervisor and coordinate this project's graphs. Use propose_work_graph with the work ID and revision to create a task-specific graph draft. Preserve the work ID when reporting results or requesting clarification."
		}
	}
	agentContext := operation.Context.AgentContext
	// Record what was actually loaded for this operation so the node
	// projection cannot later guess from catalog status.
	RecordCapabilityLoad(store, NodeCapabilityLoadInput{
		TaskId: operation.TaskId, NodeId: operation.NodeId, InstanceId: instanceId,
		OperationId: operation.Id, ReadOnly: false, Report: capabilityOperation.Report,
		Digest: capabilityOperation.BundleDigest, ToolPolicyDigest: capabilityOperation.ToolPolicyDigest,
		RuntimePolicyDigest: capabilityOperation.RuntimePolicyDigest,
	})
	// Live conversation text and tool activity are separate from the final
	// message: deltas are coalesced for reconnect, the durable record is
	// written by the kernel when the operation settles.
	live := newPiAdapterLiveTurn(store, operation, instanceId, gate, conversation)
	input.TurnOrdinalsMu.Lock()
	(*input.TurnOrdinals)[operation.Id] = live.nextOrdinal
	input.TurnOrdinalsMu.Unlock()
	onEvent := func(event map[string]any) { live.handle(event) }
	return piAdapterRunTurn(options, transport, input, piAdapterTurnInput{
		Gate: gate, ObservedGate: observedGate, Spec: spec, Conversation: conversation, Workspace: workspace,
		PermissionRequest: &permissionRequest, AskedQuestion: &askedQuestion, ReloadReceipt: &reloadReceipt,
		CapabilityOperation: capabilityOperation, ContextAssembly: contextAssembly, Commands: commands,
		Tools: tools, ThinkingLevel: thinkingLevel, ModelPolicyDigest: modelPolicyDigest,
		ToolPolicyDigest: toolPolicyDigest, ComposedPrompt: composedPrompt, AgentContext: agentContext,
		OnEvent: onEvent, Parts: live.parts, PartsOrder: live.partsOrder, FlushDeltas: live.flushDeltas,
		ToolSummaries: live.toolSummaries, ToolActivity: &live.toolActivity, Activity: &live.activity,
		NarrationByEntry: live.narrationByEntry, ToolOrdinals: live.toolOrdinals, ActiveConversationTools: live.activeConversationTools,
		PersistEntries: live.persistEntries, SawAssistantMessageEnd: &live.sawAssistantMessageEnd, Compacting: &live.compacting,
		GateRefusal: &gateRefusal, Retrieval: retrieval, ArtifactService: artifactService, Role: role,
		NextOrdinal: live.nextOrdinal,
	})
}
