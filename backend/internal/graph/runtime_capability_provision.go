package graph

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func capabilityResolveManifestDomains(declared any, label string, granted []string, secrets CapabilitySecrets) []string {
	if declared == nil {
		return NormalizeDomains(granted)
	}
	list, ok := declared.([]any)
	if !ok {
		Raise("capability_unavailable", label+" must be an array of nonempty strings")
	}
	resolved := []string{}
	for _, item := range list {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			Raise("capability_unavailable", label+" must be an array of nonempty strings")
		}
		expanded := strings.TrimSpace(text)
		expanded = capabilityEnvironmentPattern.ReplaceAllStringFunc(expanded, func(match string) string {
			parts := capabilityEnvironmentPattern.FindStringSubmatch(match)
			name := parts[1]
			if name == "" {
				name = parts[2]
			}
			replacement, ok := secrets[name]
			if !ok {
				replacement, ok = os.LookupEnv(name)
			}
			if !ok || replacement == "" {
				Raise("capability_unavailable", "MCP manifest requires environment variable "+name)
			}
			return replacement
		})
		if strings.Contains(expanded, "$") {
			Raise("capability_unavailable", label+" contains an invalid environment reference: "+text)
		}
		host := expanded
		if parsed, err := url.Parse(expanded); err == nil && parsed.Scheme != "" && parsed.Host != "" {
			if parsed.Scheme != "https" && parsed.Scheme != "http" {
				Raise("capability_unavailable", label+" URL is invalid: "+text)
			}
			if parsed.User != nil {
				Raise("capability_unavailable", label+" URL is invalid: "+text)
			}
			host = parsed.Hostname()
		} else if capabilitySchemePattern.MatchString(expanded) {
			Raise("capability_unavailable", label+" URL is invalid: "+text)
		}
		pattern, ok := capabilityDomainPattern(host)
		if !ok {
			Raise("capability_unavailable", label+" contains an invalid host: "+host)
		}
		resolved = append(resolved, pattern)
	}
	return NormalizeDomains(append(append([]string{}, granted...), resolved...))
}

func capabilityDomainPattern(host string) (string, bool) {
	pattern := ""
	recovered := false
	func() {
		defer func() {
			if recover() != nil {
				recovered = true
			}
		}()
		pattern = NormalizeDomainPattern(host)
	}()
	if recovered {
		return "", false
	}
	return pattern, true
}

func capabilityManifestNetworkDomains(manifest map[string]any, granted []string, secrets CapabilitySecrets) []string {
	return capabilityResolveManifestDomains(manifest["networkDomains"], "MCP networkDomains", granted, secrets)
}

type capabilityProvisioningPlan struct {
	manager   string
	domains   []string
	root      string
	readyFile string
	key       string
}

func capabilityProvisioningPlanFor(manifest map[string]any, snapshot string, secrets CapabilitySecrets) *capabilityProvisioningPlan {
	command := ""
	if declared, ok := manifest["command"].(string); ok {
		command = strings.TrimSpace(declared)
	}
	inferred := ""
	switch command {
	case "uvx":
		inferred = "uv"
	case "npx":
		inferred = "npm"
	}
	provisioning, hasProvisioning := manifest["provisioning"]
	if hasProvisioning && provisioning != nil && inferred == "" {
		Raise("capability_unavailable", "MCP provisioning is only valid for uvx or npx commands")
	}
	if inferred == "" {
		return nil
	}
	manager := inferred
	var extraDomains any
	if hasProvisioning && provisioning != nil {
		value, ok := provisioning.(map[string]any)
		if !ok {
			Raise("capability_unavailable", "MCP provisioning must be an object")
		}
		if declared, present := value["manager"]; present && declared != nil {
			if declared != "uv" && declared != "npm" {
				Raise("capability_unavailable", "MCP provisioning.manager must be uv or npm")
			}
			if declared != inferred {
				Raise("capability_unavailable", "MCP provisioning.manager does not match command "+command)
			}
			manager = declared.(string)
		}
		extraDomains = value["domains"]
	}
	defaults := NPM_PROVISIONING_DOMAINS
	if manager == "uv" {
		defaults = UV_PROVISIONING_DOMAINS
	}
	domains := capabilityResolveManifestDomains(extraDomains, "MCP provisioning.domains", append([]string{}, defaults...), secrets)
	key := capabilityTextDigest(CanonicalJSON(map[string]any{
		"command": command,
		"args":    manifest["args"],
		"provisioning": map[string]any{
			"manager": manager,
			"domains": domains,
		},
	}))
	root := filepath.Join(snapshot, ".graph-provisioning", key)
	return &capabilityProvisioningPlan{
		manager: manager, domains: domains, root: root,
		readyFile: filepath.Join(root, ".ready"), key: key,
	}
}

func capabilityProvisioningEnvironment(plan *capabilityProvisioningPlan, phase string) map[string]string {
	cache := filepath.Join(plan.root, "cache")
	if plan.manager == "uv" {
		env := map[string]string{
			"UV_CACHE_DIR":          cache,
			"UV_PYTHON_INSTALL_DIR": filepath.Join(plan.root, "python"),
			"UV_NO_PROGRESS":        "1",
		}
		if phase == "runtime" {
			env["UV_OFFLINE"] = "1"
		}
		return env
	}
	env := map[string]string{
		"npm_config_cache":           cache,
		"npm_config_update_notifier": "false",
		"npm_config_fund":            "false",
		"npm_config_audit":           "false",
	}
	if phase == "runtime" {
		env["npm_config_offline"] = "true"
		env["npm_config_prefer_offline"] = "true"
	}
	return env
}

func NodeReadPaths(execPath string, electron string) []string {
	macos := filepath.Dir(execPath)
	if electron != "" {
		return []string{macos, filepath.Dir(macos)}
	}
	return []string{macos}
}

func capabilityLocalNodeReadPaths(execPath string, electron string) []string {
	paths := NodeReadPaths(execPath, electron)
	if strings.HasPrefix(execPath, "/opt/homebrew/") {
		for _, candidate := range []string{
			"/opt/homebrew/opt",
			"/opt/homebrew/lib",
			"/opt/homebrew/Cellar",
			"/opt/homebrew/etc/openssl@3",
			"/opt/homebrew/etc/openssl@1.1",
		} {
			if _, err := os.Stat(candidate); err == nil {
				paths = append(paths, candidate)
			}
		}
	}
	return capabilityUniqueStrings(paths)
}

type capabilityGrants struct {
	workspace  string
	scratchDir string
}

func capabilityRunGrants(workspace string, scratchDir string) capabilityGrants {
	canonicalWorkspace := capabilityRealPath(workspace)
	if err := os.MkdirAll(scratchDir, 0o700); err != nil {
		panic(err)
	}
	return capabilityGrants{workspace: canonicalWorkspace, scratchDir: capabilityRealPath(scratchDir)}
}

func capabilityBindingKey(bound CapabilityBinding, role string) string {
	return bound.Id + "@" + bound.Version + ":" + role
}

func capabilityStableFact(fact any) map[string]any {
	record := asMap(fact)
	if record == nil {
		record = map[string]any{}
	}
	return map[string]any{
		"id":             mapString(record, "id", "Id"),
		"version":        mapString(record, "version", "Version"),
		"kind":           capabilityMapValue(record, "kind", "Kind"),
		"name":           capabilityMapValue(record, "name", "Name"),
		"description":    capabilityMapValue(record, "description", "Description"),
		"path":           capabilityMapValue(record, "path", "Path"),
		"tools":          capabilityMapList(record, "tools", "Tools"),
		"networkDomains": capabilityMapList(record, "networkDomains", "NetworkDomains"),
		"networkAccess":  capabilityMapValue(record, "networkAccess", "NetworkAccess"),
		"provisioning":   capabilityMapValue(record, "provisioning", "Provisioning"),
		"runtime":        capabilityMapValue(record, "runtime", "Runtime"),
	}
}

func capabilityMapValue(record map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, present := record[key]; present {
			return value
		}
	}
	return nil
}

func capabilityMapList(record map[string]any, keys ...string) []any {
	value := capabilityMapValue(record, keys...)
	if value == nil {
		return []any{}
	}
	list, ok := value.([]any)
	if !ok {
		return []any{}
	}
	return list
}
