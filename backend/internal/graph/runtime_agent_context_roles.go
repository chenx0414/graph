package graph

import (
	"path/filepath"
	"strings"
)

// OpenAgentContextAssembly resolves the prompt, the rules and the tool surface
// of one operation. Opening it never starts an MCP or a Pi process.
func OpenAgentContextAssembly(input AgentContextAssemblyOptions) *AgentContextAssembly {
	workspace := ""
	if input.Workspace != "" {
		resolved, err := filepath.EvalSymlinks(input.Workspace)
		if err != nil {
			// A workspace directory that no longer exists is a fact about the
			// data, not a broken daemon: measured 2026-11-02, a conversation from
			// a /private/tmp project kept answering 500 for its context preview,
			// which the console reported as a failed request.
			Raise("workspace_missing", "The conversation workspace no longer exists: "+input.Workspace)
		}
		workspace = resolved
	}
	role := agentContextRole(input.Role, input.Action)
	definitionID := ""
	if input.DefinitionVersion != "" {
		definitionID = strings.Split(input.DefinitionVersion, "@")[0]
	}
	inlinePrompt := ""
	definitionExists := false
	if input.DefinitionVersion != "" && input.Catalog != nil {
		definitionExists = input.Catalog.HasDefinition(input.DefinitionVersion)
	}
	if definitionExists {
		inlinePrompt = input.Catalog.Definition(input.DefinitionVersion).SystemPrompt
	}
	identityOverride := ""
	if inlinePrompt == "" && input.Library != nil && definitionID != "" {
		var fallback *string
		if input.Bootstrap != nil && input.Bootstrap.Agent != "" {
			value := input.Bootstrap.Agent
			fallback = &value
		}
		identityOverride = input.Library.AgentPrompt(definitionID, fallback)
	}
	bootstrap := &CapabilityBootstrap{}
	if input.Bootstrap != nil {
		copied := *input.Bootstrap
		bootstrap = &copied
	}
	switch {
	case strings.TrimSpace(inlinePrompt) != "":
		bootstrap.Agent = inlinePrompt
	case strings.TrimSpace(identityOverride) != "":
		bootstrap.Agent = identityOverride
	}
	bundleOptions := input.CapabilityBundleOptions
	bundleOptions.Bootstrap = bootstrap
	if workspace != "" {
		bundleOptions.SkillCwd = workspace
	}
	bundle := OpenCapabilityBundle(bundleOptions)
	retrievalNote := ""
	if input.Retrieval {
		retrievalNote = " The fetch tool reads HTTP documents from granted domains."
	}
	common := DEFAULT_COMMON_RULES
	roleRules := agentContextRoleRules(role)
	toolGuidance := agentContextToolGuidance(role)
	if input.Library != nil {
		common = agentContextLibraryPrompt(input.Library, "rules/common.md")
		roleRules = agentContextLibraryPrompt(input.Library, "rules/"+role+".md")
		toolGuidance = agentContextLibraryPrompt(input.Library, "tools/"+role+".md")
	} else if bootstrapTool := agentContextBootstrapTool(input.Bootstrap); bootstrapTool != "" {
		toolGuidance = bootstrapTool
	}
	var runtimeRules *string
	if role != "main" {
		if input.Runtime == "node" {
			text := DEFAULT_NODE_PROMPT
			if input.Library != nil {
				text = agentContextLibraryPrompt(input.Library, "runtime/node.md")
			}
			runtimeRules = &text
		} else {
			text := RenderAgentPrompt(DEFAULT_WORKER_PROMPT, map[string]string{"retrievalNote": retrievalNote})
			if input.Library != nil {
				text = agentContextLibraryPrompt(input.Library, "runtime/worker.md", map[string]string{"retrievalNote": retrievalNote})
			}
			runtimeRules = &text
		}
	}
	// The TypeScript read the project instructions here and never used them.
	// The read is kept so the behaviour of the library does not change.
	_, _, _ = agentContextProjectInstructions(workspace)
	disabledTools := []string{}
	if role == "main" && input.Library != nil {
		disabledTools = input.Library.DisabledTools()
	}
	definitionVersion := input.DefinitionVersion
	if definitionVersion == "" {
		definitionVersion = "unknown@1"
	}
	return &AgentContextAssembly{
		Bundle: bundle, DisabledTools: disabledTools, Role: role, DefinitionVersion: definitionVersion,
		common: common, roleRules: roleRules, toolGuidance: toolGuidance,
		runtimeRules: runtimeRules, bootstrap: bootstrap, fullAccess: input.FullAccess, rsi: input.Rsi,
		experience: input.ExperienceContext,
		catalog:    input.Catalog,
	}
}
