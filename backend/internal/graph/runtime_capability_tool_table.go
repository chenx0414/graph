package graph

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// capabilityTools exposes the tools one MCP capability offers.
func capabilityTools(connection McpExchange, tools []McpTool, capabilityId string, capabilityVersion string, authorization *capabilityAuthorization) []ToolDefinition {
	out := []ToolDefinition{}
	for _, tool := range tools {
		description := ""
		if tool.Description != nil {
			description = *tool.Description
		}
		if description == "" {
			description = "MCP tool " + tool.Name + " from " + capabilityId + "@" + capabilityVersion
		}
		parameters := tool.InputSchema
		if parameters == nil {
			parameters = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		toolName := tool.Name
		definition := ToolDefinition{
			Name:        capabilityMcpToolName(capabilityId, toolName),
			Label:       toolName + " (" + capabilityId + ")",
			Description: description,
			Parameters:  parameters,
			// Extensions load only inside the restricted worker, never in the background process.
			ExternallyGated: true,
		}
		definition.Execute = func(toolCallId string, raw any) (any, error) {
			// The bound capability loader pre-authorizes every discovered tool.
			// Explicit task grants remain an audit-compatible additional source.
			if authorization != nil {
				grant := McpGrant(capabilityId, toolName)
				if !capabilityStringListHas(authorization.grants, grant) {
					if authorization.onPermissionRequired != nil {
						authorization.onPermissionRequired(CapabilityPermissionRequest{
							Grant: grant, CapabilityId: capabilityId, Tool: toolName, Description: description,
						})
					}
					return nil, fmt.Errorf("Permission required: MCP tool %s needs the task grant %s", toolName, grant)
				}
			}
			result := CallMcpTool(connection, toolName, raw)
			content := []any{}
			for _, part := range result.Content {
				content = append(content, map[string]any{"type": part.Type, "text": part.Text})
			}
			if len(content) == 0 {
				content = append(content, map[string]any{"type": "text", "text": "MCP tool returned no content"})
			}
			if result.IsError {
				texts := []string{}
				for _, part := range result.Content {
					texts = append(texts, part.Text)
				}
				return nil, errors.New(strings.Join(texts, "\n"))
			}
			return map[string]any{"content": content, "details": map[string]any{}}, nil
		}
		out = append(out, definition)
	}
	return out
}

// capabilityStringListHas reports whether a list holds a value.
func capabilityStringListHas(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// capabilityDefinitionBindings are the bindings one Agent definition resolves: its own
// declarations, then every available capability marked `base`. A base capability therefore
// reaches every Agent without being bound anywhere, and dispatch, the console preview and the
// tests agree by construction. An explicit binding of the same id wins.
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

// capabilityDefinition reads one definition, reporting a missing one.
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

// ResolveCapabilityFacts resolves the capabilities one definition version binds.
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
			// A sourced extension has no local entry: the SDK resolves the package source at load time.
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
		if record.Kind == CapabilityKindExtension {
			entry := capabilityExtensionEntry(manifest, snapshot)
			if _, err := os.Stat(entry); err != nil {
				Raise("capability_unavailable", "Graph extension "+binding.bound.Id+"@"+binding.bound.Version+" entry does not exist")
			}
			fact := ResolvedCapabilityFact{
				Id: binding.bound.Id, Version: binding.bound.Version, Kind: record.Kind,
				Source: record.Source, Path: snapshot,
				Digest: capabilityTextDigest(CanonicalJSON(map[string]any{
					"manifest": manifest,
					"entry":    capabilityFileDigest(entry),
				})),
				Entry: &entry,
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

// capabilityFactSortKey is the key the resolved facts are ordered by.
func capabilityFactSortKey(fact ResolvedCapabilityFact) string {
	return fact.Kind + ":" + fact.Role + ":" + fact.Id + "@" + fact.Version
}

// capabilityLoadState is what one load accumulates.
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
