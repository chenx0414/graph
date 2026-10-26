package graph

import (
	"path/filepath"
	"sort"
	"strings"
)

// taskRuntimeGrants renders the sorted, deduplicated grant list of one project.
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

// configuredProjects reads the projects of the current configuration.
func (runtime *TaskRuntime) configuredProjects() []ProjectConfig {
	if runtime.live != nil && runtime.live.Projects != nil {
		return runtime.live.Projects()
	}
	return runtime.projects
}

// allowedProjects is the set of project ids that may still receive work.
func (runtime *TaskRuntime) allowedProjects() map[string]bool {
	allowed := map[string]bool{}
	for _, project := range runtime.configuredProjects() {
		allowed[project.Id] = true
	}
	return allowed
}

// liveEntries reads the configured models right now.
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

// livePreferences reads the model preferences right now.
func (runtime *TaskRuntime) livePreferences() map[ModelGrade][]string {
	preferences := map[ModelGrade][]string{}
	if runtime.live != nil && runtime.live.Preferences != nil {
		for key, values := range runtime.live.Preferences() {
			preferences[ModelGrade(key)] = values
		}
		return preferences
	}
	if runtime.models != nil {
		for key, values := range runtime.models.Preferences {
			preferences[ModelGrade(key)] = values
		}
	}
	return preferences
}

// liveBudget reads the default budget of a new instance.
func (runtime *TaskRuntime) liveBudget() *int64 {
	if runtime.live != nil && runtime.live.DefaultBudgetTokens != nil {
		budget := runtime.live.DefaultBudgetTokens()
		if budget == nil {
			return nil
		}
		value := int64(*budget)
		return &value
	}
	if runtime.limits != nil && runtime.limits.DefaultBudgetTokens != nil {
		budget := runtime.limits.DefaultBudgetTokens()
		if budget == nil {
			return nil
		}
		value := int64(*budget)
		return &value
	}
	return nil
}

// masterModel reads the master Agent model right now.
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

// masterDefinitionVersion reads the master Agent definition right now.
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

// configRevision reads the configuration revision recorded with new tasks.
func (runtime *TaskRuntime) configRevision() *int {
	if runtime.live != nil && runtime.live.Revision != nil {
		revision := runtime.live.Revision()
		return &revision
	}
	return nil
}

// resolvedAccessPolicy is the policy frozen for each admitted execution.
func (runtime *TaskRuntime) resolvedAccessPolicy() *ResolvedAccessPolicy {
	policy := AccessPolicy{}
	if runtime.access != nil {
		policy = runtime.access()
	} else {
		policy = StandardAccessPolicy()
	}
	graphHome := filepath.Join(taskRuntimeHome(), ".graph")
	if runtime.catalogOpt.CapabilityRoot != "" {
		graphHome = filepath.Dir(runtime.catalogOpt.CapabilityRoot)
	}
	return ResolveAccessPolicy(policy, AccessPolicyContext{
		Home:      taskRuntimeHome(),
		StateDir:  runtime.stateDir,
		GraphHome: graphHome,
	})
}

// dispatchAllowed reports whether the host still permits dispatch.
func (runtime *TaskRuntime) dispatchAllowed() bool {
	if runtime.rsi == nil {
		return true
	}
	return !runtime.rsi.HasPendingRestart()
}

// executionSystemContext is the host inventory the main Agent may read.
func (runtime *TaskRuntime) executionSystemContext() *ExecutionSystemContext {
	return &ExecutionSystemContext{
		Resources:         true,
		AgentCombinations: true,
		SystemSummary:     runtime.systemCtx != nil && runtime.systemCtx.SystemSummary != nil,
	}
}

// graphs lists the v2 graphs that currently have queued work.
func (runtime *TaskRuntime) graphs() []ExecutionGraph {
	lane := runtime.residentGraphLane()
	// §9: the budget a node runs under is read live, so a configuration change
	// reaches the next turn of a graph that is already running.
	budget := runtime.liveBudgetTokens()
	if runtime.laneTokenBudget != nil {
		runtime.laneTokenBudget.Budget = 0
		runtime.laneTokenBudget.Unlimited = true
		if budget != nil {
			runtime.laneTokenBudget.Budget = float64(*budget)
			runtime.laneTokenBudget.Unlimited = false
		}
	}
	runnable := lane.Runnable()
	out := make([]ExecutionGraph, 0, len(runnable))
	for _, graph := range runnable {
		run := graph.Run
		out = append(out, ExecutionGraph{TaskId: graph.TaskId, Run: func() bool { return run().Drained }})
	}
	return out
}

// liveBudgetTokens is the default token budget of one node, or nil when the
// node may spend without a cap.
func (runtime *TaskRuntime) liveBudgetTokens() *int {
	if runtime.live != nil && runtime.live.DefaultBudgetTokens != nil {
		return runtime.live.DefaultBudgetTokens()
	}
	if runtime.limits != nil && runtime.limits.DefaultBudgetTokens != nil {
		return runtime.limits.DefaultBudgetTokens()
	}
	return nil
}

// projectRootFor is the project workspace of one graph.
func (runtime *TaskRuntime) projectRootFor(graphId string) *string {
	row := kernelRow(runtime.store.Db, "SELECT p.root AS root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?", graphId)
	if row == nil {
		return nil
	}
	root := kernelString(row["root"])
	return &root
}

// residentGraphLane is the resident v2 lane of this runtime. Native graphs run
// through one resident Pi host per node.
func (runtime *TaskRuntime) residentGraphLane() *GraphLane {
	if runtime.graphLane != nil {
		return runtime.graphLane
	}
	runtime.laneTokenBudget = &TokenBudget{Budget: 0, Unlimited: true}
	reserve := float64(DEFAULT_V2_RESERVE_TOKENS)
	options := KernelGraphLaneOptions{
		Kernel:        runtime.kernel,
		Access:        runtime.resolvedAccessPolicy,
		Catalog:       runtime.catalog,
		Library:       runtime.agentContextLibrary(),
		Codemode:      runtime.options.Codemode,
		TokenBudget:   runtime.laneTokenBudget,
		ReserveTokens: &reserve,
		Directory:     runtime.liveEntries,
		Preferences:   runtime.livePreferences,
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
