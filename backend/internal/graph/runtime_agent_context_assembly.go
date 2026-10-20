package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// AgentContextTool is one tool of the context projection: what the settings
// panel shows about the tool surface of an operation.
type AgentContextTool struct {
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	Source           string   `json:"source"`
	Group            string   `json:"group,omitempty"`
	Order            *int     `json:"order,omitempty"`
	Version          *string  `json:"version"`
	Parameters       []string `json:"parameters"`
	Permission       string   `json:"permission"`
	Available        bool     `json:"available"`
	RuntimeAvailable *bool    `json:"runtimeAvailable"`
	CapabilityId     *string  `json:"capabilityId"`
	Enabled          bool     `json:"enabled"`
}

// AgentContextAssemblyOptions selects the context of one operation.
type AgentContextAssemblyOptions struct {
	CapabilityBundleOptions
	// Action is what the operation does, for example work or review.
	Action string
	// Runtime is node for a graph node, worker for a plain operation.
	Runtime string
	// Role is master, worker or reviewer.
	Role string
	// Workspace is the work copy the operation runs in.
	Workspace string
	// Library is the editable prompt library.
	Library *AgentContextLibrary
	// FullAccess opens the host gates for the main Agent.
	FullAccess bool
	// Retrieval tells the prompt that the fetch tool is available.
	Retrieval bool
	// Rsi lets the main Agent change this Graph checkout.
	Rsi bool
}

// AgentContextComposition is the prompt and the tool surface of one operation.
type AgentContextComposition struct {
	Tools        []AgentContextTool
	Capabilities []AgentCapabilityPromptEntry
	Composed     ComposedAgentSystemPrompt
	DocsRoot     string
}

// AgentContextPreview is the next-operation projection of the tool surface.
type AgentContextPreview struct {
	Tools        []AgentContextTool
	Capabilities []AgentCapabilityPromptEntry
	DocsRoot     string
}

// AgentContextAssembly is the resolved context of one operation.
type AgentContextAssembly struct {
	// Bundle is the capability closure the operation binds to.
	Bundle *CapabilityBundleVersion
	// DisabledTools are the tool names the user turned off.
	DisabledTools []string
	// Role is the effective role: main, worker or reviewer.
	Role string
	// DefinitionVersion is the recipe the context was built for.
	DefinitionVersion string
	// DocsRoot is the read-only Agent documentation directory.
	DocsRoot string

	common       string
	roleRules    string
	toolGuidance string
	runtimeRules *string
	bootstrap    *CapabilityBootstrap
	fullAccess   bool
	rsi          bool
	catalog      *Catalog
}

// OpenAgentContextAssembly resolves the prompt, the rules and the tool surface
// of one operation. Opening it never starts an MCP or a Pi process.
func OpenAgentContextAssembly(input AgentContextAssemblyOptions) *AgentContextAssembly {
	workspace := ""
	if input.Workspace != "" {
		resolved, err := filepath.EvalSymlinks(input.Workspace)
		if err != nil {
			panic(err)
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
	docs := GraphDocumentationPathsOf()
	definitionVersion := input.DefinitionVersion
	if definitionVersion == "" {
		definitionVersion = "unknown@1"
	}
	return &AgentContextAssembly{
		Bundle: bundle, DisabledTools: disabledTools, Role: role, DefinitionVersion: definitionVersion,
		DocsRoot: docs.Root, common: common, roleRules: roleRules, toolGuidance: toolGuidance,
		runtimeRules: runtimeRules, bootstrap: bootstrap, fullAccess: input.FullAccess, rsi: input.Rsi,
		catalog: input.Catalog,
	}
}

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

// ForOperation is the tool surface and the prompt of a running operation.
func (assembly *AgentContextAssembly) ForOperation(operation CapabilityOperation) AgentContextComposition {
	facts := operation.Report
	return assembly.compose(operation.Prompts.System, agentContextLoadedTools(facts, operation.Tools, operation.NativeTools),
		agentContextLoadedCapabilities(facts))
}

// Preview is the next-operation configuration of the tool surface.
func (assembly *AgentContextAssembly) Preview(features AgentToolFeatures) AgentContextPreview {
	declared := []AgentContextTool{}
	capabilities := []AgentCapabilityPromptEntry{}
	// The TypeScript read the agent prompt of an agent capability here and never
	// used it. The read is kept so the behaviour does not change.
	identity := ""
	if assembly.bootstrap != nil {
		identity = assembly.bootstrap.Agent
	}
	for _, fact := range assembly.Bundle.Facts {
		var record *CapabilityRecord
		if assembly.catalog != nil {
			record = assembly.catalog.Capability(fact.Id, fact.Version)
		}
		if fact.Role == "agent" {
			body, err := os.ReadFile(fact.Path)
			if err != nil {
				panic(err)
			}
			identity = string(body)
		}
		_ = identity
		name := fact.Id
		description := ""
		if record != nil {
			if record.Name != "" {
				name = record.Name
			}
			description = record.Description
		}
		tools := capabilityDeclaredTools(fact)
		capability := AgentCapabilityPromptEntry{
			ID: fact.Id, Version: fact.Version, Kind: fact.Kind, Name: name, Tools: []string{},
		}
		if description != "" {
			value := description
			capability.Description = &value
		}
		capabilityPath := fact.Path
		capability.Path = &capabilityPath
		if len(fact.NetworkDomains) > 0 {
			capability.NetworkDomains = append([]string{}, fact.NetworkDomains...)
		}
		reason := "Declared for the next operation; runtime availability has not been confirmed."
		capability.Reason = &reason
		for _, tool := range tools {
			capability.Tools = append(capability.Tools, tool.Name)
		}
		capabilities = append(capabilities, capability)
		for _, tool := range tools {
			version := fact.Version
			capabilityId := fact.Id
			declared = append(declared, AgentContextTool{
				Name: tool.Name, Description: tool.Description, Source: name, Version: &version,
				CapabilityId: &capabilityId, Parameters: []string{}, Permission: "definition-bound capability",
				Enabled: true, Available: true,
			})
		}
	}
	all := []AgentContextTool{}
	for _, declaration := range DescribeAgentTools(features) {
		all = append(all, agentContextHostTool(declaration))
	}
	all = append(all, declared...)
	requestedNative := PiNativeToolNamesForPlatform()
	selected := SelectAgentToolSurface(all, requestedNative, assembly.DisabledTools, nil)
	enabled := map[string]bool{}
	for _, name := range selected.NativeTools {
		enabled[name] = true
	}
	for _, tool := range selected.Tools {
		enabled[tool.Name] = true
	}
	disabled := map[string]bool{}
	for _, name := range assembly.DisabledTools {
		disabled[name] = true
	}
	visible := SelectAgentToolSurface(all, selected.NativeTools, nil, nil).Tools
	unique := map[string]AgentContextTool{}
	order := []string{}
	for _, tool := range append(append([]AgentContextTool{}, visible...), agentContextNativeTools(requestedNative)...) {
		if _, seen := unique[tool.Name]; seen {
			continue
		}
		unique[tool.Name] = tool
		order = append(order, tool.Name)
	}
	tools := []AgentContextTool{}
	for _, name := range order {
		tool := unique[name]
		tool.Enabled = !disabled[tool.Name]
		tool.Available = enabled[tool.Name]
		tools = append(tools, tool)
	}
	sort.SliceStable(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
	return AgentContextPreview{Tools: tools, Capabilities: capabilities, DocsRoot: assembly.DocsRoot}
}

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

// agentContextLoadedTools is the tool surface a running operation actually has.
func agentContextLoadedTools(facts []RuntimeCapabilityLoadFact, tools []ToolDefinition, nativeTools []string) []AgentContextTool {
	owners := map[string]RuntimeCapabilityLoadFact{}
	for _, fact := range facts {
		for _, name := range fact.Tools {
			owners[name] = fact
		}
	}
	entries := []AgentContextTool{}
	for _, tool := range tools {
		owner, hasOwner := owners[tool.Name]
		entry := agentContextHostTool(AgentToolDeclaration{
			Name: tool.Name, Description: tool.Description, Parameters: tool.Parameters,
		})
		if hasOwner {
			source := owner.Id
			if owner.Name != nil {
				source = *owner.Name
			}
			entry.Source = source
			version := owner.Version
			entry.Version = &version
			capabilityID := owner.Id
			entry.CapabilityId = &capabilityID
		}
		entries = append(entries, entry)
	}
	present := map[string]bool{}
	for _, tool := range entries {
		present[tool.Name] = true
	}
	for _, fact := range facts {
		if fact.Kind == nil || *fact.Kind != "pi-extension" {
			continue
		}
		for _, name := range fact.Tools {
			if present[name] {
				continue
			}
			present[name] = true
			source := fact.Id
			if fact.Name != nil {
				source = *fact.Name
			}
			description := "Registered by Pi extension " + source + "."
			if fact.Reason != nil {
				description = *fact.Reason
			}
			version := fact.Version
			capabilityID := fact.Id
			runtimeAvailable := fact.Loaded && fact.Executable
			entries = append(entries, AgentContextTool{
				Name: name, Description: description, Source: source, Version: &version,
				CapabilityId: &capabilityID, Parameters: []string{}, Permission: "bound Pi extension tool",
				Enabled: true, Available: runtimeAvailable, RuntimeAvailable: agentContextBool(runtimeAvailable),
			})
		}
	}
	return append(agentContextNativeTools(nativeTools), entries...)
}

// agentContextLoadedCapabilities is the capability list a running operation has.
func agentContextLoadedCapabilities(report []RuntimeCapabilityLoadFact) []AgentCapabilityPromptEntry {
	out := []AgentCapabilityPromptEntry{}
	for _, fact := range report {
		kind := "capability"
		if fact.Kind != nil {
			kind = *fact.Kind
		}
		name := fact.Id
		if fact.Name != nil {
			name = *fact.Name
		}
		entry := AgentCapabilityPromptEntry{
			ID: fact.Id, Version: fact.Version, Kind: kind, Name: name,
			Tools: append([]string{}, fact.Tools...),
		}
		if fact.Description != nil && *fact.Description != "" {
			value := *fact.Description
			entry.Description = &value
		}
		if fact.Path != nil && *fact.Path != "" {
			value := *fact.Path
			entry.Path = &value
		}
		if len(fact.NetworkDomains) > 0 {
			entry.NetworkDomains = append([]string{}, fact.NetworkDomains...)
		}
		if fact.Reason != nil && *fact.Reason != "" {
			value := *fact.Reason
			entry.Reason = &value
		}
		out = append(out, entry)
	}
	return out
}

// agentContextSchemaParameters is the sorted parameter list of one tool schema.
func agentContextSchemaParameters(schema any) []string {
	out := []string{}
	record := asMap(schema)
	if record == nil {
		return out
	}
	properties := asMap(record["properties"])
	if properties == nil {
		return out
	}
	for name := range properties {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// agentContextToolPermission is the permission line the settings panel shows.
func agentContextToolPermission(name string) string {
	switch {
	case name == "read" || name == "list_dir":
		return "workspace and granted read roots"
	case name == "write_file":
		return "workspace write"
	case name == "run_command":
		return "host-gated command policy"
	case name == "fetch":
		return "declared network domains"
	case strings.HasPrefix(name, "artifact_"):
		return "task artifact workspace"
	case name == "propose_graph" || name == "graph_patch":
		return "task graph control"
	case name == "validate_proposal" || name == "get_graph_state" || name == "get_task_status":
		return "current conversation graph"
	case name == "list_projects" || name == "bind_project":
		return "configured project binding"
	case strings.HasPrefix(name, "git_"):
		return "read-only work copy Git"
	case name == "apply_system_change" || name == "propose_system_change":
		return "user-approved system change"
	case name == "inspect_rsi_status" || name == "apply_rsi_change":
		return "Graph source checkout (self-improvement)"
	}
	return "Graph call gate and current access policy"
}

// agentContextBool is a pointer to one boolean value.
func agentContextBool(value bool) *bool {
	return &value
}
