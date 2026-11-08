package graph

import (
	"path/filepath"
	"sort"
	"strings"
)

func taskRuntimeGrants(grants []string) string {
	seen := map[string]bool{}
	out := []string{}
	for _, grant := range grants {
		if grant == "" || seen[grant] {
			continue
		}
		seen[grant] = true
		out = append(out, grant)
	}
	sort.Strings(out)
	return CanonicalJSON(out)
}

func (runtime *TaskRuntime) configuredProjects() []ProjectConfig {
	if runtime.live != nil && runtime.live.Projects != nil {
		return runtime.live.Projects()
	}
	return runtime.projects
}

func (runtime *TaskRuntime) allowedProjects() map[string]bool {
	allowed := map[string]bool{}
	for _, project := range runtime.configuredProjects() {
		allowed[project.Id] = true
	}
	return allowed
}

func (runtime *TaskRuntime) liveEntries() []ModelEntry {
	if runtime.live != nil && runtime.live.Entries != nil {
		entries := runtime.live.Entries()
		out := make([]ModelEntry, 0, len(entries))
		for _, entry := range entries {
			out = append(out, entry.ModelEntry)
		}
		return out
	}
	if runtime.models != nil {
		out := make([]ModelEntry, 0, len(runtime.models.Entries))
		for _, entry := range runtime.models.Entries {
			out = append(out, entry.ModelEntry)
		}
		return out
	}
	return []ModelEntry{}
}


func (runtime *TaskRuntime) masterModel() *string {
	if runtime.master == nil {
		return nil
	}
	model := ""
	if runtime.master.Model != nil {
		model = runtime.master.Model()
	}
	if strings.TrimSpace(model) == "" {
		return nil
	}
	return &model
}

func (runtime *TaskRuntime) masterDefinitionVersion() *string {
	if runtime.master == nil {
		return nil
	}
	version := ""
	if runtime.master.DefinitionVersion != nil {
		version = runtime.master.DefinitionVersion()
	}
	if strings.TrimSpace(version) == "" {
		return nil
	}
	return &version
}

func (runtime *TaskRuntime) configRevision() *int {
	if runtime.live != nil && runtime.live.Revision != nil {
		revision := runtime.live.Revision()
		return &revision
	}
	return nil
}

func (runtime *TaskRuntime) dispatchAllowed() bool {
	if runtime.rsi == nil {
		return true
	}
	return !runtime.rsi.HasPendingRestart()
}

func (runtime *TaskRuntime) executionSystemContext() *ExecutionSystemContext {
	return &ExecutionSystemContext{
		Resources:         true,
		AgentCombinations: true,
		SystemSummary:     runtime.systemCtx != nil && runtime.systemCtx.SystemSummary != nil,
	}
}

func (runtime *TaskRuntime) graphs() []ExecutionGraph {
	lane := runtime.residentGraphLane()
	if runtime.laneTokenBudget != nil {
		runtime.laneTokenBudget.Budget = 0
		runtime.laneTokenBudget.Unlimited = true
	}
	runnable := lane.Runnable()
	out := make([]ExecutionGraph, 0, len(runnable))
	for _, graph := range runnable {
		run := graph.Run
		out = append(out, ExecutionGraph{TaskId: graph.TaskId, Run: func() bool { return run().Drained }})
	}
	return out
}


func (runtime *TaskRuntime) projectRootFor(graphId string) *string {
	row := kernelRow(runtime.store.Db, "SELECT p.root AS root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?", graphId)
	if row == nil {
		return nil
	}
	root := kernelString(row["root"])
	return &root
}

func (runtime *TaskRuntime) residentGraphLane() *GraphLane {
	if runtime.graphLane != nil {
		return runtime.graphLane
	}
	runtime.laneTokenBudget = &TokenBudget{Budget: 0, Unlimited: true}
	reserve := float64(DEFAULT_V2_RESERVE_TOKENS)
	options := KernelGraphLaneOptions{
		Kernel:        runtime.kernel,
		Catalog:       runtime.catalog,
		Library:       runtime.agentContextLibrary(),
		Codemode:      runtime.options.Codemode,
		TokenBudget:   runtime.laneTokenBudget,
		ReserveTokens: &reserve,
		Directory:     runtime.liveEntries,
		Scheduler:     runtime.scheduler,
		CredentialFor: func(entry ModelEntry) *KernelGraphLaneCredential {
			binding := runtime.liveCredentialFor(entry)
			if binding == nil {
				return nil
			}
			credential := &KernelGraphLaneCredential{
				ApiKey:        binding.ApiKey,
				Limit:         binding.Limit,
				SharedGroupId: binding.SharedGroupId,
				GroupLimit:    binding.GroupLimit,
			}
			if binding.CredentialId != "" {
				value := binding.CredentialId
				credential.CredentialId = &value
			}
			return credential
		},
		InstancesDir: filepath.Join(runtime.stateDir, "instances"),
		StateDir:     runtime.stateDir,
		GraphHome:    runtime.graphHome(),
		WorkspaceFor: runtime.projectRootFor,
		Git:          runtime.git,
		Artifacts:    runtime.artifacts,
		OnMainMessage: func(graphId, nodeId, text, requestId string) any {
			return SendKernelMainMessage(runtime.kernel, graphId, nodeId, NodeMessageInput{Text: text, RequestID: requestId})
		},
		OnToolCall: func(graphId, nodeId, name string, args any) PiToolAnswer {
			if name != "submit" {
				return PiToolAnswer{Ok: false, Text: "the host does not offer a tool named " + name}
			}
			ok, text := HostSubmitCall(runtime.kernel, graphId, nodeId, args)
			return PiToolAnswer{Ok: ok, Text: text}
		},
	}
	runtime.graphLane = KernelGraphLane(options)
	return runtime.graphLane
}
