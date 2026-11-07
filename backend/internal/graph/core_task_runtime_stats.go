package graph

import (
	"path/filepath"
	"strings"
)

func (runtime *TaskRuntime) ToolCallStats() map[string]any {
	runtime.ensureOpen()
	IngestToolCallSpools(runtime.store, runtime.stateDir)
	return map[string]any{
		"generatedAt":   NowMillis(),
		"retentionDays": ToolCallRetentionDays,
		"stats":         runtime.store.ToolCallStats(),
	}
}

func (runtime *TaskRuntime) SkillStats() map[string]any {
	runtime.ensureOpen()
	IngestToolCallSpools(runtime.store, runtime.stateDir)
	roots := []string{}
	for _, project := range runtime.configuredProjects() {
		if strings.TrimSpace(project.Root) != "" {
			roots = append(roots, project.Root)
		}
	}
	report := SkillUsage(SkillUsageInput{Store: runtime.store, ProjectRoots: roots, CapabilityRoot: runtime.catalogOpt.CapabilityRoot})
	return map[string]any{
		"generatedAt":   NowMillis(),
		"retentionDays": ToolCallRetentionDays,
		"report":        report,
	}
}

func (runtime *TaskRuntime) PromoteSkill(skillId string) any {
	runtime.ensureOpen()
	if runtime.catalogOpt.CapabilityRoot == "" {
		Raise("invalid_config", "Capability library is unavailable")
	}
	roots := []string{}
	for _, project := range runtime.configuredProjects() {
		if strings.TrimSpace(project.Root) == "" {
			continue
		}
		resolved, err := filepath.Abs(project.Root)
		if err != nil {
			resolved = project.Root
		}
		roots = append(roots, resolved)
	}
	return PromoteSkillFromProjects(roots, skillId, runtime.catalogOpt.CapabilityRoot)
}

func (runtime *TaskRuntime) ClearToolCalls() map[string]any {
	runtime.ensureOpen()
	removed := runtime.store.ClearToolCalls()
	runtime.store.ForgetToolCallSpools()
	ClearToolCallSpools(runtime.stateDir)
	return map[string]any{"removed": removed}
}

type TaskRuntimeConversations struct {
	runtime *TaskRuntime
}

func (runtime *TaskRuntime) Insights(scope InsightsScope) InsightsSummary {
	runtime.ensureOpen()
	IngestToolCallSpools(runtime.store, runtime.stateDir)
	return runtime.store.Insights(scope)
}
