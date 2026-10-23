package graph

import (
	"os"
	"path/filepath"
	"strings"
)

// agentContextBootstrapTool is the tool prompt of a bootstrap pair.
func agentContextBootstrapTool(bootstrap *CapabilityBootstrap) string {
	if bootstrap == nil {
		return ""
	}
	return mapString(asMap(bootstrap), "Tool", "tool")
}

// agentContextLibraryPrompt reads one prompt of the library and fails on a read error.
func agentContextLibraryPrompt(library *AgentContextLibrary, key AgentPromptKey, variables ...map[string]string) string {
	prompt, err := library.Prompt(key, variables...)
	if err != nil {
		panic(err)
	}
	return prompt
}

// agentContextRole is the effective role of one operation.
func agentContextRole(role, action string) string {
	if role == "master" {
		return "main"
	}
	if strings.Contains(strings.ToLower(action), "review") {
		return "reviewer"
	}
	return "worker"
}

// agentContextRoleRules is the built-in rule set of one role.
func agentContextRoleRules(role string) string {
	switch role {
	case "main":
		return DEFAULT_MAIN_RULES
	case "reviewer":
		return DEFAULT_REVIEWER_RULES
	}
	return DEFAULT_WORKER_RULES
}

// agentContextToolGuidance is the built-in tool guidance of one role.
func agentContextToolGuidance(role string) string {
	switch role {
	case "main":
		return DEFAULT_MAIN_TOOL_GUIDANCE
	case "reviewer":
		return DEFAULT_REVIEWER_TOOL_GUIDANCE
	}
	return DEFAULT_WORKER_TOOL_GUIDANCE
}

// agentContextProjectInstructions reads the project instructions of a workspace.
func agentContextProjectInstructions(workspace string) (string, string, bool) {
	if workspace == "" {
		return "", "", false
	}
	for _, name := range []string{"AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"} {
		path := filepath.Join(workspace, name)
		body, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			panic(err)
		}
		if strings.TrimSpace(string(body)) != "" {
			return path, string(body), true
		}
	}
	return "", "", false
}
