package graph

import (
	"path/filepath"
	"regexp"
	"strings"
)

// CapabilitySecrets are the host values a capability manifest may reference.
type CapabilitySecrets = map[string]string

// CapabilityPermissionRequest is a remote MCP operation the task has not pre-authorized;
// the user answers with this exact grant.
type CapabilityPermissionRequest struct {
	Grant        string `json:"grant"`
	CapabilityId string `json:"capabilityId"`
	Tool         string `json:"tool"`
	Description  string `json:"description"`
}

// CapabilityDeclaredTool is one tool a capability manifest declares.
type CapabilityDeclaredTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// RuntimeCapabilityProvisioning is how one capability provisions its package.
type RuntimeCapabilityProvisioning struct {
	Manager string   `json:"manager"`
	Domains []string `json:"domains"`
	Path    string   `json:"path"`
}

// RuntimeCapabilityLoadFact is what one capability actually loaded.
//
// The core `CapabilityLoadFact` (src/core/node-run.ts) keeps the core field set; the runtime
// one adds the fields only the loader knows. RULEBOOK §2 keeps the core name for the core
// type, so the runtime type carries its own name.
type RuntimeCapabilityLoadFact struct {
	Id         string  `json:"id"`
	Version    string  `json:"version"`
	Kind       *string `json:"kind"`
	Loaded     bool    `json:"loaded"`
	Executable bool    `json:"executable"`
	Reason     *string `json:"reason"`
	Name       *string `json:"name,omitempty"`
	// Description is the capability's own description.
	Description *string `json:"description,omitempty"`
	Path        *string `json:"path,omitempty"`
	// Source is the declared package source when the SDK resolved the extension instead of a vendored copy.
	Source         *string                        `json:"source,omitempty"`
	Tools          []string                       `json:"tools,omitempty"`
	NetworkDomains []string                       `json:"networkDomains,omitempty"`
	NetworkAccess  string                         `json:"networkAccess,omitempty"`
	Provisioning   *RuntimeCapabilityProvisioning `json:"provisioning,omitempty"`
	// Runtime is the runtime declaration one Pi extension resolved.
	Runtime Json `json:"runtime,omitempty"`
}

// LoadedCapabilityPrompts are the prompt texts one loaded bundle carries.
type LoadedCapabilityPrompts struct {
	Agent *string `json:"agent"`
	Tool  *string `json:"tool"`
}

// LoadedCapabilities is everything one operation bound.
type LoadedCapabilities struct {
	SkillPaths               []string
	PiExtensionPaths         []string
	PiExtensionTools         []string
	ReadRoots                []string
	WriteRoots               []string
	Env                      map[string]string
	NetworkDomains           []string
	AllowUnrestrictedNetwork bool
	AllowLocalBinding        bool
	UnixSockets              []string
	Tools                    []ToolDefinition
	Prompts                  LoadedCapabilityPrompts
	Digest                   string
	Close                    func()
	Report                   []RuntimeCapabilityLoadFact
}

// ResolvedCapabilityFact is what one bound capability resolves to, before it is loaded.
type ResolvedCapabilityFact struct {
	Id             string                         `json:"id"`
	Version        string                         `json:"version"`
	Kind           string                         `json:"kind"`
	Role           string                         `json:"role,omitempty"`
	Source         string                         `json:"source"`
	Path           string                         `json:"path"`
	Digest         string                         `json:"digest"`
	DeclaredTools  []CapabilityDeclaredTool       `json:"declaredTools,omitempty"`
	Entry          *string                        `json:"entry,omitempty"`
	Command        *string                        `json:"command,omitempty"`
	Url            *string                        `json:"url,omitempty"`
	NetworkDomains []string                       `json:"networkDomains,omitempty"`
	NetworkAccess  string                         `json:"networkAccess,omitempty"`
	Provisioning   *RuntimeCapabilityProvisioning `json:"provisioning,omitempty"`
}

// CapabilityPromptsResult is the identity prompt and its digest.
type CapabilityPromptsResult struct {
	SystemPrompt string
	Digest       string
}

// capabilityBindingRole is the role one bound capability plays.
type capabilityBindingRole string

const (
	capabilityRoleCapability capabilityBindingRole = "capability"
	capabilityRoleAgent      capabilityBindingRole = "agent"
	capabilityRoleTool       capabilityBindingRole = "tool"
)

// capabilityBinding is one binding of a definition.
type capabilityBinding struct {
	bound CapabilityBinding
	role  capabilityBindingRole
}

// UV_PROVISIONING_DOMAINS are the hosts a uv-provisioned capability may reach.
var UV_PROVISIONING_DOMAINS = []string{
	"github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"pypi.org",
	"files.pythonhosted.org",
}

// NPM_PROVISIONING_DOMAINS are the hosts an npm-provisioned capability may reach.
var NPM_PROVISIONING_DOMAINS = []string{
	"registry.npmjs.org",
}

// capabilitySchemePattern matches a value that looks like it carries a URL scheme.
var capabilitySchemePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)

// capabilityEnvironmentPattern matches one environment reference in a manifest value.
var capabilityEnvironmentPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)

// capabilityVariablePattern matches a valid environment variable name.
var capabilityVariablePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// McpGrant is the grant string one MCP tool needs.
func McpGrant(capabilityId string, tool string) string {
	return "mcp:" + capabilityId + ":" + tool
}

// capabilityMcpToolName is the tool name one MCP tool is exposed under.
func capabilityMcpToolName(capabilityId string, tool string) string {
	clean := func(value string) string {
		return capabilityReplaceInvalid(value, "A-Za-z0-9_", "_")
	}
	return "mcp_" + clean(capabilityId) + "_" + clean(tool)
}

// capabilitySafeToolName is the tool name one declared tool is exposed under.
func capabilitySafeToolName(name string) string {
	clean := capabilityReplaceInvalid(name, "A-Za-z0-9_-", "_")
	clean = capabilityTrimLeadingNonAlpha(clean)
	if clean == "" {
		Raise("invalid_input", "Invalid tool name "+name)
	}
	return clean
}

// capabilityReplaceInvalid replaces every character outside the allowed set.
//
// The allowed set is a character class, so "A-Za-z0-9_-" names ranges and not
// literal characters.
func capabilityReplaceInvalid(value string, allowed string, replacement string) string {
	var b strings.Builder
	for _, character := range value {
		if capabilityAllowedRune(allowed, character) {
			b.WriteRune(character)
			continue
		}
		b.WriteString(replacement)
	}
	return b.String()
}

// capabilityAllowedRune reports whether one character is inside the allowed set.
//
// A dash between two characters names the range between them; a dash at the end of
// the set is a literal dash.
func capabilityAllowedRune(allowed string, character rune) bool {
	for index := 0; index < len(allowed); index++ {
		if index+2 < len(allowed) && allowed[index+1] == '-' {
			if character >= rune(allowed[index]) && character <= rune(allowed[index+2]) {
				return true
			}
			index += 2
			continue
		}
		if rune(allowed[index]) == character {
			return true
		}
	}
	return false
}

// capabilityTrimLeadingNonAlpha drops the leading characters that are not letters.
func capabilityTrimLeadingNonAlpha(value string) string {
	for index, character := range value {
		if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') {
			return value[index:]
		}
	}
	return ""
}

// capabilitySnapshotPath is the absolute snapshot path one catalog record carries.
func capabilitySnapshotPath(record *CapabilityRecord) string {
	if record == nil {
		Raise("capability_unavailable", "Installed capability has no absolute snapshot path")
	}
	snapshot := asMap(record.Snapshot)
	path, _ := snapshot["path"].(string)
	if !filepath.IsAbs(path) {
		Raise("capability_unavailable", "Installed capability has no absolute snapshot path")
	}
	return path
}

// capabilityDeclaredToolsFromManifest reads the tools one manifest declares.
func capabilityDeclaredToolsFromManifest(manifest map[string]any) []CapabilityDeclaredTool {
	raw, present := manifest["tools"]
	if !present || raw == nil {
		return []CapabilityDeclaredTool{}
	}
	list, ok := raw.([]any)
	if !ok {
		Raise("capability_unavailable", "Pi extension manifest tools must be an array")
	}
	declared := []CapabilityDeclaredTool{}
	for _, value := range list {
		tool, ok := value.(map[string]any)
		if !ok {
			Raise("capability_unavailable", "Pi extension tool declarations must be objects")
		}
		name, _ := tool["name"].(string)
		if strings.TrimSpace(name) == "" {
			Raise("capability_unavailable", "Pi extension tool declaration requires a name")
		}
		description := ""
		if value, present := tool["description"]; present && value != nil {
			text, ok := value.(string)
			if !ok {
				Raise("capability_unavailable", "Pi extension tool "+name+" has an invalid description")
			}
			description = text
		} else {
			description = "Pi extension tool " + name
		}
		declared = append(declared, CapabilityDeclaredTool{Name: capabilitySafeToolName(name), Description: description})
	}
	return declared
}

// capabilityPiExtensionRuntime is the runtime declaration one manifest carries.
type capabilityPiExtensionRuntime struct {
	commands          []string
	env               map[string]string
	hasEnv            bool
	readPaths         []string
	writePaths        []string
	networkDomains    []string
	networkAccess     string
	allowLocalBinding bool
	unixSockets       []string
}
