package graph

import (
	"path/filepath"
	"strings"

	"os"
)

func agentContextBootstrapTool(bootstrap *CapabilityBootstrap) string {
	if bootstrap == nil {
		return ""
	}
	return mapString(asMap(bootstrap), "Tool", "tool")
}

func agentContextLibraryPrompt(library *AgentContextLibrary, key AgentPromptKey, variables ...map[string]string) string {
	prompt, err := library.Prompt(key, variables...)
	if err != nil {
		panic(err)
	}
	return prompt
}

func agentContextRole(role, action string) string {
	if role == "master" {
		return "main"
	}
	if strings.Contains(strings.ToLower(action), "review") {
		return "reviewer"
	}
	return "worker"
}

func agentContextRoleRules(role string) string {
	switch role {
	case "main":
		return DEFAULT_MAIN_RULES
	case "reviewer":
		return DEFAULT_REVIEWER_RULES
	}
	return DEFAULT_WORKER_RULES
}

func agentContextToolGuidance(role string) string {
	switch role {
	case "main":
		return DEFAULT_MAIN_TOOL_GUIDANCE
	case "reviewer":
		return DEFAULT_REVIEWER_TOOL_GUIDANCE
	}
	return DEFAULT_WORKER_TOOL_GUIDANCE
}

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
