package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func LoadCapabilities(input CapabilityLoadInput) LoadedCapabilities {
	state := &capabilityLoadState{
		skillPaths: []string{}, piExtensionPaths: []string{}, piExtensionTools: []string{},
		readRoots: []string{}, writeRoots: []string{}, env: map[string]string{},
		runtimeNetworkDomains: []string{}, runtimeUnixSockets: []string{}, tools: []ToolDefinition{},
	}
	if input.Bootstrap != nil {
		state.agentPrompt = strings.TrimSpace(input.Bootstrap.Agent)
		state.toolPrompt = strings.TrimSpace(input.Bootstrap.Tool)
	}
	report := []RuntimeCapabilityLoadFact{}
	closeLoaded := func() {
		for index := len(state.releases) - 1; index >= 0; index-- {
			state.releases[index]()
		}
		state.releases = []func(){}
	}
	digest := func() string {
		stable := []any{}
		for _, fact := range report {
			stable = append(stable, capabilityStableFact(fact))
		}
		toolFacts := []any{}
		for _, tool := range state.tools {
			toolFacts = append(toolFacts, map[string]any{
				"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters,
			})
		}
		var definitionVersion any
		if input.HasDefinitionVersion {
			definitionVersion = input.DefinitionVersion
		}
		var agent any
		if state.agentPrompt != "" {
			agent = state.agentPrompt
		}
		var tool any
		if state.toolPrompt != "" {
			tool = state.toolPrompt
		}
		return capabilityTextDigest(CanonicalJSON(map[string]any{
			"definitionVersion":        definitionVersion,
			"report":                   stable,
			"skillPaths":               state.skillPaths,
			"piExtensionPaths":         state.piExtensionPaths,
			"piExtensionTools":         state.piExtensionTools,
			"writeRoots":               state.writeRoots,
			"env":                      state.env,
			"networkDomains":           state.runtimeNetworkDomains,
			"allowUnrestrictedNetwork": state.runtimeUnrestrictedNetwork,
			"allowLocalBinding":        state.runtimeLocalBinding,
			"unixSockets":              state.runtimeUnixSockets,
			"prompts": map[string]any{
				"agent": agent,
				"tool":  tool,
			},
			"tools": toolFacts,
		}))
	}
	finish := func() LoadedCapabilities {
		return LoadedCapabilities{
			SkillPaths: state.skillPaths, PiExtensionPaths: state.piExtensionPaths, PiExtensionTools: state.piExtensionTools,
			ReadRoots: state.readRoots, WriteRoots: state.writeRoots, Env: state.env,
			NetworkDomains: state.runtimeNetworkDomains, AllowUnrestrictedNetwork: state.runtimeUnrestrictedNetwork,
			AllowLocalBinding: state.runtimeLocalBinding, UnixSockets: state.runtimeUnixSockets,
			Tools:   state.tools,
			Prompts: LoadedCapabilityPrompts{Agent: capabilityOptionalString(state.agentPrompt), Tool: capabilityOptionalString(state.toolPrompt)},
			Digest:  digest(), Close: closeLoaded, Report: report,
		}
	}
	if !input.HasDefinitionVersion || input.DefinitionVersion == "" {
		return finish()
	}
	definition, found := capabilityDefinition(input.Catalog, input.DefinitionVersion)
	if input.FrozenFacts != nil {
		definition = CatalogDefinition{}
		for _, fact := range input.FrozenFacts {
			definition.Capabilities = append(definition.Capabilities, CapabilityBinding{Id: fact.Id, Version: fact.Version})
		}
		found = true
	}
	if !found {
		return finish()
	}
	bindings := capabilityDefinitionBindings(definition, input.Catalog)
	if input.FrozenFacts != nil {
		bindings = nil
		for _, fact := range input.FrozenFacts {
			role := capabilityRoleCapability
			if fact.Kind == "prompt" && fact.Role == "agent" {
				role = capabilityRoleAgent
			}
			if fact.Kind == "prompt" && fact.Role == "tool" {
				role = capabilityRoleTool
			}
			bindings = append(bindings, capabilityBinding{bound: CapabilityBinding{Id: fact.Id, Version: fact.Version}, role: role})
		}
	}
	declaredKeys := map[string]bool{}
	if input.FrozenFacts != nil {
		for _, binding := range bindings {
			declaredKeys[capabilityBindingKey(binding.bound, string(binding.role))] = true
		}
	}
	for _, binding := range definition.Capabilities {
		declaredKeys[capabilityBindingKey(binding, string(capabilityRoleCapability))] = true
	}
	if definition.Prompts != nil && definition.Prompts.Agent != nil {
		declaredKeys[capabilityBindingKey(*definition.Prompts.Agent, string(capabilityRoleAgent))] = true
	}
	if definition.Prompts != nil && definition.Prompts.Tool != nil {
		declaredKeys[capabilityBindingKey(*definition.Prompts.Tool, string(capabilityRoleTool))] = true
	}
	seen := map[string]bool{}
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				closeLoaded()
				panic(recovered)
			}
		}()
		for _, binding := range bindings {
			seenKey := capabilityBindingKey(binding.bound, string(binding.role))
			if seen[seenKey] {
				continue
			}
			seen[seenKey] = true
			facts, failure := capabilityLoadOne(input, binding, state)
			if failure != nil {
				if declaredKeys[seenKey] {
					panic(failure)
				}
				kind := ""
				if record := capabilityInputRecord(input, binding); record != nil {
					kind = record.Kind
				}
				report = append(report, RuntimeCapabilityLoadFact{
					Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(kind),
					Loaded: false, Executable: false,
					Reason: capabilityOptionalString("基础能力加载失败，已跳过（它不在本 Agent 的配方里）：" + capabilityFailureMessage(failure)),
				})
				continue
			}
			report = append(report, facts...)
		}
	}()
	state.runtimeNetworkDomains = []string{}
	state.runtimeUnrestrictedNetwork = true
	state.runtimeLocalBinding = true
	return finish()
}

func capabilityFailureMessage(failure any) string {
	if err, ok := failure.(*RuntimeError); ok && err != nil {
		return err.Message
	}
	if err, ok := failure.(error); ok {
		return err.Error()
	}
	return fmt.Sprintf("%v", failure)
}

func capabilityOptionalString(value string) *string {
	if value == "" {
		return nil
	}
	text := value
	return &text
}

func capabilityLoadOne(input CapabilityLoadInput, binding capabilityBinding, state *capabilityLoadState) ([]RuntimeCapabilityLoadFact, any) {
	record := capabilityInputRecord(input, binding)
	if record == nil || record.Status != "available" {
		Raise("capability_unavailable", "Capability "+binding.bound.Id+"@"+binding.bound.Version+" is not available in the capability directory")
	}
	snapshot := capabilitySnapshotPath(record)
	if record.Kind == CapabilityKindPrompt {
		if binding.role == capabilityRoleCapability {
			Raise("capability_unsupported", "Prompt capability "+binding.bound.Id+"@"+binding.bound.Version+" must be bound under prompts")
		}
		file := "tool.md"
		if binding.role == capabilityRoleAgent {
			file = "agent.md"
		}
		text := capabilityPromptText(snapshot, file)
		if binding.role == capabilityRoleAgent {
			state.agentPrompt = text
		} else {
			parts := []string{}
			if state.toolPrompt != "" {
				parts = append(parts, state.toolPrompt)
			}
			parts = append(parts, text)
			state.toolPrompt = strings.Join(parts, "\n\n")
		}
		reason := "能力感知 Prompt 已注入"
		if binding.role == capabilityRoleAgent {
			reason = "身份 Prompt 已注入"
		}
		return []RuntimeCapabilityLoadFact{{
			Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
			Loaded: true, Executable: false, Reason: capabilityOptionalString(reason),
		}}, nil
	}
	if binding.role != capabilityRoleCapability {
		Raise("capability_unsupported", string(binding.role)+" prompt binding "+binding.bound.Id+"@"+binding.bound.Version+" is not a prompt capability")
	}
	if record.Kind == CapabilityKindSkill {
		skillFile := filepath.Join(snapshot, "SKILL.md")
		if _, err := os.Stat(skillFile); err != nil {
			Raise("capability_unavailable", "Skill "+binding.bound.Id+"@"+binding.bound.Version+" has no SKILL.md")
		}
		body, err := os.ReadFile(skillFile)
		if err != nil {
			panic(err)
		}
		metadata := capabilitySkillMetadata(string(body))
		state.skillPaths = append(state.skillPaths, snapshot)
		state.readRoots = append(state.readRoots, snapshot)
		fact := RuntimeCapabilityLoadFact{
			Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
			Loaded: true, Executable: false,
			Reason: capabilityOptionalString("原生 skills 注入：模型按需读取 SKILL.md"),
			Path:   capabilityOptionalString(skillFile),
		}
		if name, ok := metadata["name"]; ok {
			fact.Name = capabilityOptionalString(name)
		}
		if description, ok := metadata["description"]; ok {
			fact.Description = capabilityOptionalString(description)
		}
		return []RuntimeCapabilityLoadFact{fact}, nil
	}
	if record.Kind == CapabilityKindPiExtension {
		return capabilityLoadPiExtension(input, binding, record, snapshot, state)
	}
	if record.Kind != CapabilityKindMCP {
		Raise("capability_unsupported", "Capability kind "+record.Kind+" is not loadable")
	}
	return []RuntimeCapabilityLoadFact{{
		Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
		Loaded: true, Executable: true,
	}}, nil
}
