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
	if role == "master" && conversation != nil && conversation.ProjectId == nil &&
		channels != nil && channels.Rsi != nil && channels.Rsi.CheckoutRoot != nil {
		if root := strings.TrimSpace(rsiStringValue(channels.Rsi.CheckoutRoot())); root != "" {
			workspace = piAdapterRealpath(root)
		}
	}
	retrieval := piAdapterRetrievalReach(options.Network, role, observedGate)
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
		var nativeToolInput *AgentToolsInput
		operationInput.HostTools = func(readRoots []string) []ToolDefinition {
			tools := AgentToolsInput{
				Workspace: workspace, Role: role, ReadRoots: append([]string{}, readRoots...), Catalog: options.Catalog,
				Desktop: OpenDesktopTools(desktopCapabilityRoot(options.Catalog)),
				Run: func(command string, args []string, signal *AbortSignal) CommandResult {
					return piAdapterRunToolCommand(commands, input.InterruptSignal, command, args, signal, 0)
				},
				RunWithTimeout: func(command string, args []string, signal *AbortSignal, timeoutMs int) CommandResult {
					return piAdapterRunToolCommand(commands, input.InterruptSignal, command, args, signal, timeoutMs)
				},
			}
			built := tools
			nativeToolInput = &built
			if role != "" {
				tools.Role = role
			}
			if conversation != nil && conversation.Role == ConversationProject && role == "master" && conversation.AnchorTaskId == operation.TaskId {
				tools.OnAskSupervisor = func(request PiAdapterAskedQuestion) {
					if askedQuestion == nil {
						request.ToSupervisor = true
						askedQuestion = &request
					}
				}
				tools.OnNotifySupervisor = func(notice PiAdapterSupervisorNotice) any {
					notice.EvidenceExcerpt, notice.EvidenceFailure = noticeEvidenceExcerpt(notice.ArtifactID, notice.ArtifactVersion, func(id string, version int, maxBytes int) ArtifactRead {
						if artifactService == nil {
							Raise("invalid_state", "This session has no artifact workspace")
						}
						if version <= 0 {
							version = artifactService.Get(id, nil).Version
						}
						return artifactService.Read(id, version, maxBytes)
					})
					return RecordSupervisorNotice(options.Store, operation.TaskId, SupervisorNotice{
						Text: notice.Text, Milestone: notice.Milestone, WorkID: notice.WorkID, Evidence: notice.Evidence, RequestID: notice.RequestID,
						EvidenceExcerpt: notice.EvidenceExcerpt, ArtifactID: notice.ArtifactID, ArtifactVersion: notice.ArtifactVersion, EvidenceFailure: notice.EvidenceFailure,
					})
				}
			}
			if retrieval != nil {
				tools.Fetch = func(url string, signal *AbortSignal) RetrievalResult {
					return piAdapterFetchDocument(retrieval, input.InterruptSignal, url, signal)
				}
			}
			if artifactService != nil {
				tools.Artifacts = artifactService
			}
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
			if channels != nil {
				supervisor := channels.Supervisor(operation.TaskId)
				tools.Supervisor = supervisor
				tools.ControlTask = supervisor.ControlTask
				tools.GraphManagement = supervisor.GraphManagement
				tools.Catalog = channels.Catalog
			}
			if channels != nil && channels.Rsi != nil && role == "master" && input.FullAccess &&
				(conversation == nil || conversation.Role == ConversationGlobal) {
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
						return ProposeSystemChange(store, operation.TaskId, operation.NodeId, SystemChangeProposal{
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
	composedPrompt += masterPromptSuffix(store, conversation, role)
	agentContext := operation.Context.AgentContext
	RecordCapabilityLoad(store, NodeCapabilityLoadInput{
		TaskId: operation.TaskId, NodeId: operation.NodeId, InstanceId: instanceId,
		OperationId: operation.Id, ReadOnly: false, Report: capabilityOperation.Report,
		Digest: capabilityOperation.BundleDigest, ToolPolicyDigest: capabilityOperation.ToolPolicyDigest,
		RuntimePolicyDigest: capabilityOperation.RuntimePolicyDigest,
	})
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
