package graph

import (
	"os"
	"strings"
)

// compose renders the system prompt of one operation.
func (assembly *AgentContextAssembly) compose(identity string, tools []AgentContextTool, capabilities []AgentCapabilityPromptEntry) AgentContextComposition {
	available := map[string]bool{}
	for _, tool := range tools {
		if tool.Enabled && tool.Available {
			available[tool.Name] = true
		}
	}
	commonRules := assembly.common
	// Match only the built-in rules; user-owned text is never rewritten.
	if os.Getenv("GRAPH_MATCH_SEARCH_GUIDANCE") == "1" && commonRules == DEFAULT_COMMON_RULES {
		searchRule := agentContextSearchRule(DEFAULT_COMMON_RULES)
		matched := []string{}
		// BUG(port): the TypeScript list names ffind twice; the duplicate is kept.
		for _, name := range []string{"ffind", "ffind", "ffgrep", "find", "grep", "bash"} {
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
	docs := GraphDocumentationPathsOf()
	composeInput := ComposeAgentSystemPromptInput{
		Identity: identity, DefinitionVersion: assembly.DefinitionVersion, ToolGuidance: assembly.toolGuidance,
		RulesCommon: commonRules, RulesRole: assembly.roleRules, Docs: docs, Role: assembly.Role,
		CompactDocumentation: os.Getenv("GRAPH_COMPACT_DOCUMENTATION") == "1",
	}
	if assembly.runtimeRules != nil {
		composeInput.RulesRuntime = *assembly.runtimeRules
	}
	composeInput.ExperienceContext = assembly.experience
	if assembly.fullAccess && assembly.Role == "main" {
		composeInput.IdentityContext = DEFAULT_MAIN_FULL_ACCESS_IDENTITY
	}
	if assembly.rsi && assembly.Role == "main" {
		if os.Getenv("GRAPH_CLASSIFY_HARNESS_FRICTION") == "1" {
			composeInput.HarnessContext = CLASSIFIED_MAIN_RSI_IDENTITY
		} else {
			composeInput.HarnessContext = DEFAULT_MAIN_RSI_IDENTITY
		}
	}
	return AgentContextComposition{
		Tools: tools, Capabilities: capabilities, Composed: ComposeAgentSystemPrompt(composeInput), DocsRoot: docs.Root,
	}
}

// agentContextSearchRule is the built-in rule line about repository search.
func agentContextSearchRule(rules string) string {
	for _, line := range strings.Split(rules, "\n") {
		if strings.HasPrefix(line, "- Search the repository with the indexed extension tools") {
			return line
		}
	}
	return ""
}

// agentContextHostTool is one declared tool of the host surface.
func agentContextHostTool(declaration AgentToolDeclaration) AgentContextTool {
	return AgentContextTool{
		Name: declaration.Name, Description: declaration.Description, Source: "Graph",
		Parameters: agentContextSchemaParameters(declaration.Parameters), Permission: agentContextToolPermission(declaration.Name),
		Enabled: true, Available: true, RuntimeAvailable: agentContextBool(true),
	}
}

// agentContextNativeTools is the native tool surface of one operation.
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
