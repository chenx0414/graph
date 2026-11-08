package graph

import (
	"path/filepath"
	"strings"

	"encoding/json"
)

func (state *kernelGraphLaneState) laneOptions() GraphLaneOptions {
	return GraphLaneOptions{
		Kernel: state.options.Kernel,
		Finalize: func(graphId string) {
			if state.options.Git == nil || state.options.Kernel.Store.Task(graphId).IntegrationBranch == nil {
				return
			}
			state.options.Git.Exclusive(graphId, func() any {
				if state.closing.Load() || phaseClosed(state.options.Kernel.Store.Task(graphId).Phase) {
					return nil
				}
				acceptance := GraphAcceptance(state.options.Kernel, graphId, state.options.Artifacts)
				if !acceptance.Ready || acceptance.Commit == nil || *acceptance.Commit == "" {
					return nil
				}
				result := state.options.Git.TryDeliver(graphId, acceptance.Commit)
				if result.Status == "merged" {
					state.options.Kernel.RecordCompletionDelivery(graphId, *acceptance.Commit)
					return nil
				}
				state.options.Kernel.Store.Event(graphId, "graph.delivery.pending", map[string]any{
					"status": result.Status, "commit": *acceptance.Commit, "detail": result.Data,
				})
				return nil
			})
		},
		SettleWorkspace: func(executionId string) {
			execution := state.options.Kernel.Execution(executionId)
			if execution == nil || state.options.Git == nil || state.options.Kernel.Store.Task(execution.TaskId).IntegrationBranch == nil {
				return
			}
			state.options.Git.Exclusive(execution.TaskId, func() any {
				phase := state.options.Kernel.Store.Task(execution.TaskId).Phase
				if state.closing.Load() || phase == "stopping" || phase == "stopped" {
					Raise("paused", "Git integration is closed")
				}
				revision := state.options.Kernel.Revision(execution.TaskId, execution.RevisionVersion)
				if revision == nil {
					return nil
				}
				node, ok := revision.Definition.Nodes[execution.NodeId]
				if !ok {
					return nil
				}
				known := state.options.Catalog.HasDefinition(node.Recipe)
				if known && state.options.Catalog.Definition(node.Recipe).Review {
					return nil
				}
				if node.Integrate != nil && !*node.Integrate {
					return nil
				}
				admitted := kernelGraphLaneAdmittedNode(state.options.Kernel, execution.TaskId, execution.NodeId)
				result := state.options.Git.Integrate(GitIntegrateInput{
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
				workspace := state.options.WorkspaceFor(graphId)
				if state.options.Git != nil {
					if copy := state.options.Git.Workspace(graphId, nil, request.ModuleId, "program", "graph.command"); copy != nil {
						workspace = copy
					}
				}
				if workspace == nil {
					panic(errorString("Operation module has no workspace"))
				}
				program := &ModuleOperationProgram{}
				if state.options.Program != nil {
					program.ReadPaths = state.options.Program.ReadPaths
					program.Env = state.options.Program.Env
					program.NodeModulesPath = state.options.Program.NodeModulesPath
				}
				if program.NodeModulesPath == nil {
					base := *workspace
					if project := state.options.WorkspaceFor(graphId); project != nil {
						base = *project
					}
					modules := filepath.Join(base, "node_modules")
					program.NodeModulesPath = &modules
				}
				input := ModuleOperationInput{
					Kernel: state.options.Kernel, GraphId: graphId, ModuleId: request.ModuleId, DeliveryId: request.DeliveryId,
					RevisionVersion: request.RevisionVersion, Operation: request.Operation, Workspace: *workspace,
					ScratchRoot: state.options.StateDir, State: request.State, Inputs: request.Inputs, Signal: request.Signal,
					Program: program,
					IntegratesSource: func(executionId string) bool {
						execution := state.options.Kernel.Execution(executionId)
						if execution == nil {
							return false
						}
						revision := state.options.Kernel.Revision(execution.TaskId, execution.RevisionVersion)
						if revision == nil {
							return false
						}
						node, ok := revision.Definition.Nodes[execution.NodeId]
						if !ok {
							return false
						}
						if state.options.Catalog.HasDefinition(node.Recipe) && state.options.Catalog.Definition(node.Recipe).Review {
							return false
						}
						admitted := kernelGraphLaneAdmittedNode(state.options.Kernel, execution.TaskId, execution.NodeId)
						return admitted.InstanceId != ""
					},
				}
				return ExecuteModuleOperation(input)
			}
			if state.options.Git != nil {
				return state.options.Git.Exclusive(graphId, func() any { return execute() }).(ModuleOperationResponse)
			}
			return execute()
		},
		CloseGraph: func(graphId string) {
			for _, key := range state.hosts.Keys() {
				if !strings.HasPrefix(key, graphId+"/") {
					continue
				}
				_ = state.hosts.Get(key).Dispose()
				state.hosts.Delete(key)
				state.hostConfigs.Delete(key)
				state.boundModels.Delete(key)
				state.preparedReviewExecutions.Delete(key)
				if session, ok := state.sessions.Lookup(key); ok && session.Close != nil {
					session.Close()
				}
				state.sessions.Delete(key)
				state.sessionRevisions.Delete(key)
			}
		},
		Close: func() {
			state.closing.Store(true)
			for _, key := range state.hosts.Keys() {
				host := state.hosts.Get(key)
				_ = host.Dispose()
				state.hosts.Delete(key)
			}
			for _, key := range state.sessions.Keys() {
				session := state.sessions.Get(key)
				if session.Close != nil {
					session.Close()
				}
				state.sessions.Delete(key)
				state.sessionRevisions.Delete(key)
			}
			state.hostConfigs.Clear()
			state.boundModels.Clear()
		},
		Workspace: func(graphId, nodeId string) *string {
			return state.nodeWorkspace(graphId, nodeId, nil)
		},
		Config: func(graphId, nodeId string, revisionVersion int) any {
			session := state.sessionFor(graphId, nodeId, revisionVersion)
			recipe := session.Binding.DefinitionVersion
			var model *ModelEntry
			if frozen := state.restoring.Get(graphId + "/" + nodeId); frozen != nil {
				configuration := frozen.Record.Configuration
				body, _ := json.Marshal(asMap(configuration.ExecutionConfiguration)["model"])
				var entry ModelEntry
				if err := json.Unmarshal(body, &entry); err != nil {
					panic(err)
				}
				restoreDurableModelHeaders(configuration, &entry, state.options.Directory())
				model = &entry
			} else {
				model = ModelFor(state.options, recipe, &ModelForContext{GraphId: graphId, NodeId: nodeId, RevisionVersion: revisionVersion})
			}
			if model == nil {
				Raise("model_selection", "No eligible configured model for recipe "+recipe+"; review excludes recorded implementer models")
			}
			state.boundModels.Store(graphId+"/"+nodeId, *model)
			credential := state.options.CredentialFor(*model)
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
			tools = append(tools, kernelGraphLaneSubmitTool())
			nativeTools := []string{}
			skillPaths := []string{}
			piExtensionPaths := []string{}
			piExtensionTools := []string{}
			var skillFolder *string
			if session.Operation != nil {
				nativeTools = append(nativeTools, session.Operation.NativeTools...)
				skillPaths = append(skillPaths, session.Operation.SkillPaths...)
				piExtensionPaths = append(piExtensionPaths, session.Operation.PiExtensionPaths...)
				piExtensionTools = append(piExtensionTools, session.Operation.PiExtensionTools...)
				if session.Operation.SkillFolder != "" {
					folder := session.Operation.SkillFolder
					skillFolder = &folder
				}
			}
			cwds := []string{workspace}
			if project := state.options.WorkspaceFor(graphId); project != nil {
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
			}
			state.options.Kernel.RecordNodeBinding(graphId, nodeId, model.Id, session.SystemPrompt, kernelGraphLaneJSON(session.AllowedToolNames), session.StateDir, session.Role, kernelGraphLaneJSON(environment))
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
				SystemPrompt:         session.SystemPrompt,
				AllowedToolNames:     allowedToolNames,
				BundleDigest:         session.BundleDigest,
				ToolPolicyDigest:     session.ToolPolicyDigest,
				RuntimePolicyDigest:  session.RuntimePolicyDigest,
			}
			execution := state.options.Kernel.RunningExecution(graphId, nodeId)
			if execution == nil {
				Raise("invalid_execution", "Node host has no admitted execution")
			}
			workerConfig.ExecutionId = execution.Id
			workerConfig.NodeExecutionConfiguration = map[string]any{"model": *model, "role": session.Role, "revision": revisionVersion, "base": environment.Base}
			workerConfig.CredentialReference = map[string]any{"modelId": model.Id, "provider": model.Provider, "credentialId": model.CredentialId}
			workerConfig.CapabilityDescriptor = session.Operation.Descriptor
			if frozen := state.restoring.Get(graphId + "/" + nodeId); frozen != nil {
				configuration := frozen.Record.Configuration
				workerConfig.NodeExecutionConfiguration = asMap(configuration.ExecutionConfiguration)
				workerConfig.CredentialReference = asMap(configuration.CredentialReference)
				workerConfig.CapabilityDescriptor = frozen.Descriptor
				workerConfig.PiExtensionTools = append([]string{}, frozen.Record.Policy.PiExtensionTools...)
				workerConfig.AllowedToolNames = append([]string{}, frozen.Record.Policy.AllowedToolNames...)
				allowedToolNames = append([]string{}, frozen.Record.Policy.AllowedToolNames...)
			}
			return workerConfig

		},
		Host: func(graphId, nodeId string, config any, revisionVersion int) ExecutorHost {
			return state.host(graphId, nodeId, config, revisionVersion)
		},
	}
}
