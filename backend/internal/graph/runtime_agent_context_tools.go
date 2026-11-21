package graph

import (
	"strings"

	"os"
)

func (assembly *AgentContextAssembly) compose(identity string, tools []AgentContextTool, capabilities []AgentCapabilityPromptEntry) AgentContextComposition {
	available := map[string]bool{}
	for _, tool := range tools {
		if tool.Enabled && tool.Available {
			available[tool.Name] = true
		}
	}
	commonRules := assembly.common
	if os.Getenv("GRAPH_MATCH_SEARCH_GUIDANCE") == "1" && commonRules == DEFAULT_COMMON_RULES {
		searchRule := agentContextSearchRule(DEFAULT_COMMON_RULES)
		matched := []string{}
		for _, name := range []string{"find", "grep", "bash"} {
			if available[name] {
				matched = append(matched, name)
			}
		}
		listed := strings.Join(matched, ", ")
		if listed == "" {
			listed = "none"
		}
		commonRules = strings.Replace(commonRules, searchRule,
			"- Repository search tools available in this session: "+listed+
				". Use an available indexed search tool when it fits; otherwise use an available native search tool or shell rg. Indexed search tools absent from this list are not bound to this session.", 1)
	}
	composeInput := ComposeAgentSystemPromptInput{
		Identity: identity, DefinitionVersion: assembly.DefinitionVersion, ToolGuidance: assembly.toolGuidance,
		RulesCommon: commonRules, RulesRole: assembly.roleRules, Role: assembly.Role,
	}
	if assembly.runtimeRules != nil {
		composeInput.RulesRuntime = *assembly.runtimeRules
	}
	composeInput.ExperienceContext = assembly.experience
	if assembly.rsi && assembly.Role == "main" {
		if os.Getenv("GRAPH_CLASSIFY_HARNESS_FRICTION") == "1" {
			composeInput.HarnessContext = CLASSIFIED_MAIN_RSI_IDENTITY
		} else {
			composeInput.HarnessContext = DEFAULT_MAIN_RSI_IDENTITY
		}
	}
	return AgentContextComposition{
		Tools: tools, Capabilities: capabilities, Composed: ComposeAgentSystemPrompt(composeInput),
	}
}

func agentContextSearchRule(rules string) string {
	for _, line := range strings.Split(rules, "\n") {
		if strings.HasPrefix(line, "- Search the repository with the indexed extension tools") {
			return line
		}
	}
	return ""
}

func agentContextHostTool(declaration AgentToolDeclaration) AgentContextTool {
	return AgentContextTool{
		Name: declaration.Name, Description: declaration.Description, Source: "Graph",
		Parameters: agentContextSchemaParameters(declaration.Parameters), Permission: agentContextToolPermission(declaration.Name),
		Enabled: true, Available: true, RuntimeAvailable: agentContextBool(true),
	}
}

func agentContextNativeTools(names []string) []AgentContextTool {
	out := []AgentContextTool{}
	for _, tool := range PiNativeToolPromptEntries(names) {
		out = append(out, AgentContextTool{
			Name: tool.Name, Description: tool.Description, Source: tool.Source, Group: tool.Group, Order: tool.Order,
			Parameters: append([]string{}, tool.Parameters...), Permission: tool.Permission, Available: true,
			RuntimeAvailable: agentContextBool(true), Enabled: true,
		})
	}
	return out
}
