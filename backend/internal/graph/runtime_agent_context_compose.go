package graph

import (
	"sort"

	"os"
)

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
