package graph

import (
	"path/filepath"
	"regexp"
	"strings"
)

type CapabilitySecrets = map[string]string

type CapabilityPermissionRequest struct {
	Grant        string `json:"grant"`
	CapabilityId string `json:"capabilityId"`
	Tool         string `json:"tool"`
	Description  string `json:"description"`
}

type CapabilityDeclaredTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type RuntimeCapabilityProvisioning struct {
	Manager string   `json:"manager"`
	Domains []string `json:"domains"`
	Path    string   `json:"path"`
}

type RuntimeCapabilityLoadFact struct {
	Id         string  `json:"id"`
	Version    string  `json:"version"`
	Kind       *string `json:"kind"`
	Loaded     bool    `json:"loaded"`
	Executable bool    `json:"executable"`
	Reason     *string `json:"reason"`
	Name       *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	Path        *string `json:"path,omitempty"`
	Source         *string                        `json:"source,omitempty"`
	Tools          []string                       `json:"tools,omitempty"`
	NetworkDomains []string                       `json:"networkDomains,omitempty"`
	NetworkAccess  string                         `json:"networkAccess,omitempty"`
	Provisioning   *RuntimeCapabilityProvisioning `json:"provisioning,omitempty"`
	Runtime Json `json:"runtime,omitempty"`
}

type LoadedCapabilityPrompts struct {
	Agent *string `json:"agent"`
	Tool  *string `json:"tool"`
}

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

type CapabilityPromptsResult struct {
	SystemPrompt string
	Digest       string
}

type capabilityBindingRole string

const (
	capabilityRoleCapability capabilityBindingRole = "capability"
	capabilityRoleAgent      capabilityBindingRole = "agent"
	capabilityRoleTool       capabilityBindingRole = "tool"
)

type capabilityBinding struct {
	bound CapabilityBinding
	role  capabilityBindingRole
}

var UV_PROVISIONING_DOMAINS = []string{
	"github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"pypi.org",
	"files.pythonhosted.org",
}

var NPM_PROVISIONING_DOMAINS = []string{
	"registry.npmjs.org",
}

var capabilitySchemePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)

var capabilityEnvironmentPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)

var capabilityVariablePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func McpGrant(capabilityId string, tool string) string {
	return "mcp:" + capabilityId + ":" + tool
}

func capabilityMcpToolName(capabilityId string, tool string) string {
	clean := func(value string) string {
		return capabilityReplaceInvalid(value, "A-Za-z0-9_", "_")
	}
	return "mcp_" + clean(capabilityId) + "_" + clean(tool)
}

func capabilitySafeToolName(name string) string {
	clean := capabilityReplaceInvalid(name, "A-Za-z0-9_-", "_")
	clean = capabilityTrimLeadingNonAlpha(clean)
	if clean == "" {
		Raise("invalid_input", "Invalid tool name "+name)
	}
	return clean
}

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

func capabilityTrimLeadingNonAlpha(value string) string {
	for index, character := range value {
		if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') {
			return value[index:]
		}
	}
	return ""
}

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
