package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func capabilityStringListHas(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func capabilityDefinitionBindings(definition CatalogDefinition, catalog *Catalog) []capabilityBinding {
	declared := definition.Capabilities
	bound := map[string]bool{}
	for _, binding := range declared {
		bound[binding.Id] = true
	}
	out := []capabilityBinding{}
	for _, binding := range declared {
		out = append(out, capabilityBinding{bound: binding, role: capabilityRoleCapability})
	}
	if definition.Prompts != nil && definition.Prompts.Agent != nil {
		out = append(out, capabilityBinding{bound: *definition.Prompts.Agent, role: capabilityRoleAgent})
	}
	if definition.Prompts != nil && definition.Prompts.Tool != nil {
		out = append(out, capabilityBinding{bound: *definition.Prompts.Tool, role: capabilityRoleTool})
	}
	if catalog != nil {
		for _, record := range catalog.Capabilities() {
			if !record.Base || record.Status != "available" || bound[record.Id] {
				continue
			}
			out = append(out, capabilityBinding{
				bound: CapabilityBinding{Id: record.Id, Version: record.Version},
				role:  capabilityRoleCapability,
			})
		}
	}
	return out
}

func capabilityDefinition(catalog *Catalog, version string) (CatalogDefinition, bool) {
	if catalog == nil {
		return CatalogDefinition{}, false
	}
	definition := CatalogDefinition{}
	found := false
	func() {
		defer func() {
			if recover() != nil {
				found = false
			}
		}()
		definition = catalog.Definition(version)
		found = true
	}()
	return definition, found
}

func ResolveCapabilityFacts(catalog *Catalog, definitionVersion string) []ResolvedCapabilityFact {
	facts := []ResolvedCapabilityFact{}
	if definitionVersion == "" {
		return facts
	}
	definition, found := capabilityDefinition(catalog, definitionVersion)
	if !found {
		return facts
	}
	bindings := capabilityDefinitionBindings(definition, catalog)
	seen := map[string]bool{}
	for _, binding := range bindings {
		key := string(binding.role) + ":" + binding.bound.Id + "@" + binding.bound.Version
		if seen[key] {
			continue
		}
		seen[key] = true
		record := catalog.Capability(binding.bound.Id, binding.bound.Version)
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
			body := capabilityPromptText(snapshot, file)
			role := "tool"
			if binding.role == capabilityRoleAgent {
				role = "agent"
			}
			facts = append(facts, ResolvedCapabilityFact{
				Id: binding.bound.Id, Version: binding.bound.Version, Kind: record.Kind, Role: role,
				Source: record.Source, Path: filepath.Join(snapshot, file), Digest: capabilityTextDigest(body),
			})
			continue
		}
		if binding.role != capabilityRoleCapability {
			Raise("capability_unsupported", string(binding.role)+" prompt binding "+binding.bound.Id+"@"+binding.bound.Version+" is not a prompt capability")
		}
		manifest := capabilityManifestOf(snapshot)
		if record.Kind == CapabilityKindSkill {
			file := filepath.Join(snapshot, "SKILL.md")
			if _, err := os.Stat(file); err != nil {
				Raise("capability_unavailable", "Skill "+binding.bound.Id+"@"+binding.bound.Version+" has no SKILL.md")
			}
			body, err := os.ReadFile(file)
			if err != nil {
				panic(err)
			}
			facts = append(facts, ResolvedCapabilityFact{
				Id: binding.bound.Id, Version: binding.bound.Version, Kind: record.Kind,
				Source: record.Source, Path: file, Digest: capabilityTextDigest(string(body)),
			})
			continue
		}
		if record.Kind == CapabilityKindPiExtension {
			declared := capabilityDeclaredToolsFromManifest(manifest)
			packageSource := ""
			if value, ok := manifest["source"].(string); ok && strings.TrimSpace(value) != "" {
				packageSource = strings.TrimSpace(value)
			}
			entry := ""
			if packageSource == "" {
				entry = capabilityExtensionEntry(manifest, snapshot)
				if _, err := os.Stat(entry); err != nil {
					Raise("capability_unavailable", "Pi extension "+binding.bound.Id+"@"+binding.bound.Version+" entry does not exist")
				}
			}
			digest := map[string]any{"manifest": manifest}
			if entry != "" {
				digest["entry"] = capabilityFileDigest(entry)
			}
			fact := ResolvedCapabilityFact{
				Id: binding.bound.Id, Version: binding.bound.Version, Kind: record.Kind,
				Source: record.Source, Path: snapshot, Digest: capabilityTextDigest(CanonicalJSON(digest)),
				DeclaredTools: declared,
			}
			if entry != "" {
				value := entry
				fact.Entry = &value
			}
			facts = append(facts, fact)
			continue
		}
		fact := ResolvedCapabilityFact{
			Id: binding.bound.Id, Version: binding.bound.Version, Kind: record.Kind,
			Source: record.Source, Path: snapshot, Digest: capabilityTextDigest(CanonicalJSON(manifest)),
		}
		if command, ok := manifest["command"].(string); ok {
			value := command
			fact.Command = &value
		}
		if remote, ok := manifest["url"].(string); ok {
			value := remote
			fact.Url = &value
		}
		if declared, ok := manifest["networkDomains"].([]any); ok {
			domains := []string{}
			for _, item := range declared {
				if text, ok := item.(string); ok {
					domains = append(domains, text)
				}
			}
			if len(domains) > 0 {
				fact.NetworkDomains = domains
			}
		}
		if manifest["networkAccess"] == "unrestricted" {
			fact.NetworkAccess = "unrestricted"
		}
		manager := ""
		switch manifest["command"] {
		case "uvx":
			manager = "uv"
		case "npx":
			manager = "npm"
		}
		if manager != "" {
			domains := NPM_PROVISIONING_DOMAINS
			if manager == "uv" {
				domains = UV_PROVISIONING_DOMAINS
			}
			fact.Provisioning = &RuntimeCapabilityProvisioning{Manager: manager, Domains: append([]string{}, domains...)}
		}
		facts = append(facts, fact)
	}
	sort.SliceStable(facts, func(left int, right int) bool {
		return capabilityFactSortKey(facts[left]) < capabilityFactSortKey(facts[right])
	})
	return facts
}

func capabilityFactSortKey(fact ResolvedCapabilityFact) string {
	return fact.Kind + ":" + fact.Role + ":" + fact.Id + "@" + fact.Version
}

type capabilityLoadState struct {
	skillPaths                 []string
	piExtensionPaths           []string
	piExtensionTools           []string
	readRoots                  []string
	writeRoots                 []string
	env                        map[string]string
	runtimeNetworkDomains      []string
	runtimeUnixSockets         []string
	runtimeUnrestrictedNetwork bool
	runtimeLocalBinding        bool
	tools                      []ToolDefinition
	agentPrompt                string
	toolPrompt                 string
	releases                   []func()
}
