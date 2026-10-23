package graph

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// laneOptions are the lane's own hooks: the graph lifecycle, the
// workspace, the module operations and the resident host.
func (state *kernelGraphLaneState) laneOptions() GraphLaneOptions {
	return GraphLaneOptions{
		Kernel: state.options.Kernel,
		Finalize: func(graphId string) {
			if state.options.Git == nil || state.options.Kernel.Store.Task(graphId).IntegrationBranch == nil {
				return
			}
			state.options.Git.Exclusive(graphId, func() any {
				if state.closing || phaseClosed(state.options.Kernel.Store.Task(graphId).Phase) {
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
				// The TypeScript check is ['stopping', 'stopped']; a completed task is
				// not a closed integration.
				phase := state.options.Kernel.Store.Task(execution.TaskId).Phase
				if state.closing || phase == "stopping" || phase == "stopped" {
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
				// Reviewer reports are shared artifacts; they must not become implementation changes.
				if known && state.options.Catalog.Definition(node.Recipe).Review {
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
					// The same facts settleWorkspace uses decide whether this delivery's source owes the
					// integration branch a commit, so a check never waits on a source that never integrates.
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
				if state.options.Access != nil {
					input.Access = state.options.Access()
				}
				return ExecuteModuleOperation(input)
			}
			// A check observes one integration tip; managed merges cannot race its receipt.
			if state.options.Git != nil {
				return state.options.Git.Exclusive(graphId, func() any { return execute() }).(ModuleOperationResponse)
			}
			return execute()
		},
		CloseGraph: func(graphId string) {
			for key := range state.hosts {
				if !strings.HasPrefix(key, graphId+"/") {
					continue
				}
				_ = state.hosts[key].Dispose()
				delete(state.hosts, key)
				delete(state.hostConfigs, key)
				delete(state.boundModels, key)
				delete(state.preparedReviewExecutions, key)
				if session, ok := state.sessions[key]; ok && session.Close != nil {
					session.Close()
				}
				delete(state.sessions, key)
				delete(state.sessionRevisions, key)
			}
		},
		Close: func() {
			state.closing = true
			for key, host := range state.hosts {
				_ = host.Dispose()
				delete(state.hosts, key)
			}
			for key, session := range state.sessions {
				if session.Close != nil {
					session.Close()
				}
				delete(state.sessions, key)
				delete(state.sessionRevisions, key)
			}
			state.hostConfigs = map[string]string{}
			state.boundModels = map[string]ModelEntry{}
		},
		// A node's declared deliverable is settled from its own work copy into the shared
		// artifact store, so work the node produced is published without a tool call (§13.8).
		Workspace: func(graphId, nodeId string) *string {
			return state.nodeWorkspace(graphId, nodeId, nil)
		},
		Config: func(graphId, nodeId string, revisionVersion int) any {
			session := state.sessionFor(graphId, nodeId, revisionVersion)
			recipe := session.Binding.DefinitionVersion
			var model *ModelEntry
			if frozen := state.restoring[graphId+"/"+nodeId]; frozen != nil {
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
			state.boundModels[graphId+"/"+nodeId] = *model
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
				environment.Access = session.Environment.Access
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
				McpAdapterServers:    mcpAdapterServers,
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
			workerConfig.NodeExecutionConfiguration = map[string]any{"model": *model, "role": session.Role, "revision": revisionVersion, "base": environment.Base, "access": environment.Access}
			workerConfig.CredentialReference = map[string]any{"modelId": model.Id, "provider": model.Provider, "credentialId": model.CredentialId}
			workerConfig.CapabilityDescriptor = session.Operation.Descriptor
			if frozen := state.restoring[graphId+"/"+nodeId]; frozen != nil {
				// The turn is sent again with the admission it was accepted
				// with: the configuration it was admitted with, the credential
				// it may spend and the capability surface it was given.
				configuration := frozen.Record.Configuration
				workerConfig.NodeExecutionConfiguration = asMap(configuration.ExecutionConfiguration)
				workerConfig.CredentialReference = asMap(configuration.CredentialReference)
				workerConfig.CapabilityDescriptor = frozen.Descriptor
			}
			return workerConfig

		},
		// One resident process per node, reused across turns.
		// One resident process per node, reused across turns.
		Host: func(graphId, nodeId string, config any, revisionVersion int) ExecutorHost {
			return state.host(graphId, nodeId, config, revisionVersion)
		},
	}
}
