package graph

import (
	"sort"
	"strings"
)

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
