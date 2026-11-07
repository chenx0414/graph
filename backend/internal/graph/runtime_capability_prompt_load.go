package graph

import (
	"path/filepath"
	"strings"
)

func CapabilityPrompts(input CapabilityPromptsInput) CapabilityPromptsResult {
	systemPrompt := ""
	if input.AgentPrompt != nil {
		systemPrompt = *input.AgentPrompt
	}
	if systemPrompt == "" {
		role := ""
		if input.Role != "" {
			role = " (" + input.Role + ")"
		}
		systemPrompt = strings.Join([]string{
			"You are the " + input.Action + " Agent in Graph" + role + ".",
			"Work only within the confirmed task and the capabilities listed in tool.md.",
			"Use tools for evidence. Do not claim a tool result that did not happen.",
		}, "\n")
	}
	stable := []any{}
	for _, fact := range input.Report {
		stable = append(stable, capabilityStableFact(fact))
	}
	toolFacts := []any{}
	for _, tool := range input.Tools {
		toolFacts = append(toolFacts, map[string]any{
			"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters,
		})
	}
	var role any
	if input.Role != "" {
		role = input.Role
	}
	digest := capabilityTextDigest(CanonicalJSON(map[string]any{
		"definitionVersion": input.DefinitionVersion,
		"action":            input.Action,
		"role":              role,
		"systemPrompt":      systemPrompt,
		"report":            stable,
		"tools":             toolFacts,
	}))
	return CapabilityPromptsResult{SystemPrompt: systemPrompt, Digest: digest}
}

func capabilityRuntimeError(code string, message string) *RuntimeError {
	return &RuntimeError{Code: code, Message: message}
}

type capabilityRestrictedExecutor interface {
	Run(command RestrictedCommand) McpRunResult
}

func capabilityRestrictedExecutorOf(executor any) (capabilityRestrictedExecutor, bool) {
	adapter, ok := executor.(interface {
		Run(command RestrictedCommand) CommandResult
	})
	if !ok {
		return nil, false
	}
	return RestrictedMcpExecutor{Executor: adapter}, true
}

func capabilityInputRecord(input CapabilityLoadInput, binding capabilityBinding) *CapabilityRecord {
	if input.FrozenFacts != nil {
		for _, fact := range input.FrozenFacts {
			if fact.Id == binding.bound.Id && fact.Version == binding.bound.Version {
				path := fact.Path
				if fact.Kind == "skill" && filepath.Base(path) == "SKILL.md" {
					path = filepath.Dir(path)
				}
				return &CapabilityRecord{Id: fact.Id, Version: fact.Version, Kind: fact.Kind, Status: "available", Snapshot: map[string]any{"path": path}}
			}
		}
		return nil
	}
	return input.Catalog.Capability(binding.bound.Id, binding.bound.Version)
}
