package graph

import (
	"path/filepath"
)

func (runtime *TaskRuntime) agentContextLibrary() *AgentContextLibrary {
	return runtime.agentCtx
}

func (runtime *TaskRuntime) graphHome() string {
	if runtime.catalogOpt != nil && runtime.catalogOpt.CapabilityRoot != "" {
		return filepath.Dir(runtime.catalogOpt.CapabilityRoot)
	}
	return filepath.Join(taskRuntimeHome(), ".graph")
}

func (runtime *TaskRuntime) mainAdapterOptions() PiAdapterOptions {
	options := PiAdapterOptions{
		Store:        runtime.store,
		InstancesDir: filepath.Join(runtime.stateDir, "instances"),
		Catalog:      runtime.catalog,
		Artifacts:    runtime.artifacts,
		Directory:    runtime.liveEntries,
		ApiKey:       runtime.apiKey(),
		ApiKeyFor:    runtime.apiKeyFor,
		BindingFor:   runtime.liveCredentialFor,
		Scheduler:    runtime.scheduler,
		ModelRuntime: runtime.modelRuntime(),
		Channels:     runtime.piChannels(),
		TaskSetups:   runtime.taskSetups,
	}
	options.Transport = CreatePigAgentSessionTransport(runtime.store, codemodeSettings(runtime.options.Codemode, runtime.stateDir))
	options.DaemonNativeTools = true
	return options
}

func (runtime *TaskRuntime) fallbackAdapter() *ActionAdapter {
	adapter := CreatePiAdapter(runtime.mainAdapterOptions())
	return &adapter
}

func (runtime *TaskRuntime) apiKey() *string {
	if runtime.models == nil || runtime.models.APIKey == "" {
		return nil
	}
	key := runtime.models.APIKey
	return &key
}

func (runtime *TaskRuntime) apiKeyFor(entry ModelEntry) *string {
	binding := runtime.liveCredentialFor(entry)
	if binding == nil || binding.ApiKey == "" {
		return nil
	}
	key := binding.ApiKey
	return &key
}

func (runtime *TaskRuntime) configuredById() map[string]ConfiguredModel {
	out := map[string]ConfiguredModel{}
	for _, entry := range runtime.liveConfiguredEntries() {
		out[entry.Id] = entry
	}
	return out
}

func (runtime *TaskRuntime) liveCredentialFor(entry ModelEntry) *PiAdapterBinding {
	configured, ok := runtime.configuredById()[entry.Id]
	if !ok {
		return nil
	}
	var resolved *ResolvedCredential
	if runtime.live != nil && runtime.live.CredentialFor != nil {
		resolved = runtime.live.CredentialFor(configured)
	} else if runtime.models != nil && runtime.models.CredentialFor != nil {
		resolved = runtime.models.CredentialFor(configured)
	}
	if resolved == nil {
		if runtime.models == nil || runtime.models.APIKey == "" {
			return nil
		}
		return &PiAdapterBinding{ApiKey: runtime.models.APIKey}
	}
	binding := &PiAdapterBinding{
		ApiKey:       resolved.APIKey,
		CredentialId: resolved.CredentialID,
		Limit:        resolved.Limit,
		GroupLimit:   resolved.GroupLimit,
	}
	if resolved.SharedGroupID != "" {
		shared := resolved.SharedGroupID
		binding.SharedGroupId = &shared
	}
	return binding
}

func (runtime *TaskRuntime) modelRuntime() *ModelRuntime {
	if runtime.models == nil {
		return nil
	}
	return runtime.models.ModelRuntime
}

func (runtime *TaskRuntime) piChannels() *PiAdapterChannels {
	channels := &PiAdapterChannels{
		Supervisor: func(taskId string) PiAdapterSupervisor {
			supervisor := runtime.Supervisor(taskId)
			channel := PiAdapterSupervisor{
				ControlTask: func(input AgentToolsControlTask) any {
					var tokens *int64
					if input.Tokens != nil {
						value := int64(*input.Tokens)
						tokens = &value
					}
					return supervisor.ControlTask(TaskRuntimeControlInput{Action: input.Action, TaskId: input.TaskId, NodeId: input.NodeId, Text: input.Text, Tokens: tokens, Reason: input.Reason, RequestId: input.RequestId, SourceMessageID: input.SourceMessageID, Instruction: input.Instruction})
				},
				Propose: func(proposal NativeProposal, requestId string, newVersion bool) any {
					return supervisor.Propose(TaskRuntimeProposeInput{
						ProposalVersion: proposal.RequirementVersion,
						Summary:         proposal.Summary,
						Acceptance:      proposal.Acceptance,
						Decisions:       proposal.Decisions,
						HasDecisions:    proposal.Decisions != nil,
						Definition:      proposal.Definition,
						RequestId:       requestId,
						NewVersion:      newVersion,
					})
				},
				WithdrawDraft: func(input PiAdapterDraftAction) any {
					return supervisor.WithdrawDraft(TaskRuntimeWithdrawInput{
						ProposalVersion: input.ProposalVersion,
						Reason:          input.Reason,
						RequestId:       input.RequestId,
					})
				},
				ConfirmDraft: func(input PiAdapterConfirmDraft) any {
					return supervisor.ConfirmDraft(TaskRuntimeConfirmInput{
						ProposalVersion: input.ProposalVersion,
						DraftRevision:   input.DraftRevision,
						TargetBranch:    input.TargetBranch,
						RequestId:       input.RequestId,
						Attestation: &TaskRuntimeAttestation{
							Actor:       "agent",
							OnBehalfOf:  "user",
							Instruction: input.Instruction,
						},
					})
				},
				GraphState:       func() any { return supervisor.GraphState() },
				TaskStatus:       func(input PiAdapterTaskStatus) any { return supervisor.TaskStatus(TaskRuntimeTaskStatusInput(input)) },
				ValidateProposal: func(proposal NativeProposal) any { return supervisor.ValidateProposal(proposal) },
				ListProjects:     func() any { return supervisor.ListProjects() },
				BindProject:      func(input PiAdapterBindProject) any { return supervisor.BindProject(input.ProjectId, input.RequestId) },
				ListProblems:     func() any { return supervisor.ListProblems() },
				ResolveProblem: func(input PiAdapterResolveProblem) any {
					return supervisor.ResolveProblem(TaskRuntimeResolveInput{
						QuestionId:       input.QuestionId,
						Action:           input.Action,
						Response:         input.Response,
						Proof:            input.Proof,
						RequestId:        input.RequestId,
						ExpectedRevision: input.ExpectedRevision,
					})
				},
				GraphManagement: runtime.graphManagement(taskId, true),
			}
			conversation := ConversationForTask(runtime.store, taskId)
			if conversation != nil && (conversation.Role == ConversationGlobal || conversation.Role == ConversationProject) && conversation.AnchorTaskId == taskId {
				channel.ResumeWork = func(input WorkResumeInstruction) any {
					input.CallerTaskID = taskId
					return runtime.ResumeWorkBySupervisor(input)
				}
				channel.ReadWorkDraft = func(workID string, version int64) any { return runtime.ReadWorkDraft(taskId, workID, version) }
			}
			if conversation != nil && conversation.Role == ConversationProject && conversation.AnchorTaskId == taskId {
				channel.ProposeWorkGraph = func(input WorkDraftToolInput) any { return runtime.ProposeWorkGraph(taskId, input) }
			}
			if conversation != nil && conversation.Role == ConversationGlobal && conversation.AnchorTaskId == taskId {
				channel.DelegateWork = func(input DelegateWorkInput) any { return runtime.DelegateFromGlobal(taskId, input) }
				channel.BindProject = nil
			}
			return channel
		},
		Catalog: runtime.catalog,
		Peers: func(taskId string) PiAdapterPeers {
			return PiAdapterPeers{Deliver: func(from string, input PiAdapterPeerDelivery) any {
				nodeInput := NodeMessageInput{Text: input.Text, RequestID: input.RequestId}
				if input.To == "main" {
					return SendKernelMainMessage(runtime.kernel, taskId, from, nodeInput)
				}
				sender := from
				return SendKernelNodeMessage(runtime.kernel, taskId, input.To, nodeInput, &sender)
			}}
		},
	}
	if runtime.agentCtx != nil {
		channels.AgentContext = runtime.agentCtx
	}
	if runtime.catalogOpt != nil {
		channels.BootstrapPrompts = runtime.catalogOpt.BootstrapPrompts
		if runtime.catalogOpt.BootstrapToolPrompt != "" {
			prompt := runtime.catalogOpt.BootstrapToolPrompt
			channels.BootstrapToolPrompt = &prompt
		}
	}
	if rsi := runtime.piRsiChannel(); rsi != nil {
		channels.Rsi = rsi
	}
	if runtime.systemCtx != nil && runtime.systemCtx.SystemSummary != nil {
		channels.SystemContext = &PiAdapterSystemContext{SystemSummary: func() map[string]any {
			summary := runtime.systemCtx.SystemSummary()
			record, _ := summary.(map[string]any)
			if record == nil {
				record = map[string]any{}
			}
			return record
		}}
	}
	return channels
}
