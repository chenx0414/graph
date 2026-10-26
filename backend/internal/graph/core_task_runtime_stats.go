package graph

import (
	"path/filepath"
	"strings"
)

// ToolCallStats reads the durable tool-call telemetry.
func (runtime *TaskRuntime) ToolCallStats() map[string]any {
	runtime.ensureOpen()
	IngestToolCallSpools(runtime.store, runtime.stateDir)
	return map[string]any{
		"generatedAt":   NowMillis(),
		"retentionDays": ToolCallRetentionDays,
		"stats":         runtime.store.ToolCallStats(),
	}
}

// SkillStats reads the skill usage telemetry.
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

// PromoteSkill promotes one project skill into the capability library.
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

// ClearToolCalls drops the recorded tool calls.
func (runtime *TaskRuntime) ClearToolCalls() map[string]any {
	runtime.ensureOpen()
	removed := runtime.store.ClearToolCalls()
	runtime.store.ForgetToolCallSpools()
	ClearToolCallSpools(runtime.stateDir)
	return map[string]any{"removed": removed}
}

// TaskRuntimeConversations is the conversation side of one runtime.
type TaskRuntimeConversations struct {
	runtime *TaskRuntime
}
