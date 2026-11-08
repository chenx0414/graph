package graph

import (
	"path/filepath"
	"strings"
)

func capabilityBundleResolve(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return absolute
}

func capabilityBundleSafePath(path string) string {
	if path == "" || filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		Raise("invalid_capability", "Capability bundle file paths must be relative")
	}
	normalized := capabilityBundlePrefix.ReplaceAllString(strings.ReplaceAll(path, "\\", "/"), "")
	for _, part := range strings.Split(normalized, "/") {
		if part == "" || part == "." || part == ".." {
			Raise("invalid_capability", "Capability bundle file paths cannot traverse directories")
		}
	}
	resolved, err := filepath.Rel(".", filepath.Join(".", normalized))
	if err != nil {
		Raise("invalid_capability", "Capability bundle file path escapes its directory")
	}
	if strings.HasPrefix(resolved, "..") || filepath.IsAbs(resolved) {
		Raise("invalid_capability", "Capability bundle file path escapes its directory")
	}
	return resolved
}

func capabilityBundleValidateFiles(manifest CapabilityManifest, files map[string]string) {
	if len(files) > 64 {
		Raise("invalid_capability", "A capability bundle may contain at most 64 files")
	}
	bytes := 0
	for path, content := range files {
		normalized := capabilityBundleSafePath(path)
		if normalized == "capability.json" {
			Raise("invalid_capability", "capability.json is generated from the manifest")
		}
		bytes += len([]byte(content))
		if bytes > 2_000_000 {
			Raise("invalid_capability", "A capability bundle may contain at most 2 MB of text")
		}
	}
	for _, value := range manifest.Headers {
		if !capabilityBundleHeaderRef.MatchString(value) {
			Raise("invalid_capability", "Literal credential headers are not allowed; use headersEnv instead")
		}
	}
	if manifest.Kind == CapabilityKindSkill && strings.TrimSpace(files["SKILL.md"]) == "" {
		Raise("invalid_capability", "A skill bundle requires SKILL.md")
	}
	if manifest.Kind == CapabilityKindPrompt {
		name := "agent.md"
		if manifest.Role == "tool" {
			name = "tool.md"
		}
		if strings.TrimSpace(files[name]) == "" {
			Raise("invalid_capability", "A "+manifest.Role+" prompt bundle requires "+name)
		}
	}
	entry := manifest.Entry
	if entry == "" {
		entry = "./index.mjs"
	}
	entry = capabilityBundlePrefix.ReplaceAllString(entry, "")
	if manifest.Kind == CapabilityKindPiExtension && strings.TrimSpace(files[entry]) == "" {
		Raise("invalid_capability", "An extension bundle requires "+entry)
	}
}

func capabilityBundleManifestJSON(manifest CapabilityManifest) map[string]any {
	out := map[string]any{}
	for key, value := range manifest.Extra {
		out[key] = value
	}
	out["id"] = manifest.Id
	out["kind"] = manifest.Kind
	out["version"] = manifest.Version
	out["name"] = manifest.Name
	if manifest.Description != "" {
		out["description"] = manifest.Description
	}
	if manifest.Role != "" {
		out["role"] = manifest.Role
	}
	if manifest.Base {
		out["base"] = true
	}
	if manifest.Command != "" {
		out["command"] = manifest.Command
	}
	if manifest.Args != nil {
		out["args"] = manifest.Args
	}
	if manifest.Url != "" {
		out["url"] = manifest.Url
	}
	if manifest.Provisioning != nil {
		provisioning := map[string]any{"manager": manifest.Provisioning.Manager}
		if manifest.Provisioning.Domains != nil {
			provisioning["domains"] = manifest.Provisioning.Domains
		}
		out["provisioning"] = provisioning
	}
	if manifest.Headers != nil {
		out["headers"] = manifest.Headers
	}
	if manifest.HeadersEnv != nil {
		out["headersEnv"] = manifest.HeadersEnv
	}
	if manifest.NetworkDomains != nil {
		out["networkDomains"] = manifest.NetworkDomains
	}
	if manifest.NetworkAccess != "" {
		out["networkAccess"] = manifest.NetworkAccess
	}
	if manifest.Entry != "" {
		out["entry"] = manifest.Entry
	}
	if manifest.Tools != nil {
		tools := make([]map[string]any, 0, len(manifest.Tools))
		for _, tool := range manifest.Tools {
			entry := map[string]any{"name": tool.Name}
			if tool.Description != "" {
				entry["description"] = tool.Description
			}
			tools = append(tools, entry)
		}
		out["tools"] = tools
	}
	if manifest.Runtime != nil {
		runtime := map[string]any{}
		if manifest.Runtime.Commands != nil {
			runtime["commands"] = manifest.Runtime.Commands
		}
		if manifest.Runtime.Env != nil {
			runtime["env"] = manifest.Runtime.Env
		}
		if manifest.Runtime.ReadPaths != nil {
			runtime["readPaths"] = manifest.Runtime.ReadPaths
		}
		if manifest.Runtime.WritePaths != nil {
			runtime["writePaths"] = manifest.Runtime.WritePaths
		}
		if manifest.Runtime.NetworkDomains != nil {
			runtime["networkDomains"] = manifest.Runtime.NetworkDomains
		}
		if manifest.Runtime.NetworkAccess != "" {
			runtime["networkAccess"] = manifest.Runtime.NetworkAccess
		}
		if manifest.Runtime.AllowLocalBinding != nil {
			runtime["allowLocalBinding"] = *manifest.Runtime.AllowLocalBinding
		}
		if manifest.Runtime.UnixSockets != nil {
			runtime["unixSockets"] = manifest.Runtime.UnixSockets
		}
		out["runtime"] = runtime
	}
	if manifest.Tags != nil {
		out["tags"] = manifest.Tags
	}
	return out
}
