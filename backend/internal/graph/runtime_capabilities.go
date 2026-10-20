package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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

// capabilityRuntimeDeclaration reads the runtime declaration of one manifest.
func capabilityRuntimeDeclaration(value any) *capabilityPiExtensionRuntime {
	if value == nil {
		return nil
	}
	raw, ok := value.(map[string]any)
	if !ok {
		Raise("capability_unavailable", "Pi extension runtime must be an object")
	}
	declaration := &capabilityPiExtensionRuntime{env: map[string]string{}}
	if commands, present := raw["commands"]; present && commands != nil {
		declaration.commands = capabilityRuntimeStrings(commands, "Pi extension runtime.commands")
	}
	if env, present := raw["env"]; present && env != nil {
		values, ok := env.(map[string]any)
		if !ok {
			Raise("capability_unavailable", "Pi extension runtime.env must be a string map with valid variable names")
		}
		for name, entry := range values {
			if !capabilityVariablePattern.MatchString(name) {
				Raise("capability_unavailable", "Pi extension runtime.env must be a string map with valid variable names")
			}
			text, ok := entry.(string)
			if !ok {
				Raise("capability_unavailable", "Pi extension runtime.env must be a string map with valid variable names")
			}
			declaration.env[name] = strings.TrimSpace(text)
			declaration.hasEnv = true
		}
	}
	if access, present := raw["networkAccess"]; present && access != nil {
		if access != "unrestricted" {
			Raise("capability_unavailable", "Pi extension runtime.networkAccess must be \"unrestricted\"")
		}
		declaration.networkAccess = "unrestricted"
	}
	if domains, present := raw["networkDomains"]; present && domains != nil {
		declaration.networkDomains = capabilityRuntimeStrings(domains, "Pi extension runtime.networkDomains")
	}
	if declaration.networkDomains != nil && declaration.networkAccess != "" {
		Raise("capability_unavailable", "Pi extension runtime cannot combine networkDomains with unrestricted network access")
	}
	if binding, present := raw["allowLocalBinding"]; present && binding != nil {
		value, ok := binding.(bool)
		if !ok {
			Raise("capability_unavailable", "Pi extension runtime.allowLocalBinding must be boolean")
		}
		declaration.allowLocalBinding = value
	}
	if paths, present := raw["readPaths"]; present && paths != nil {
		declaration.readPaths = capabilityRuntimeStrings(paths, "Pi extension runtime.readPaths")
	}
	if paths, present := raw["writePaths"]; present && paths != nil {
		declaration.writePaths = capabilityRuntimeStrings(paths, "Pi extension runtime.writePaths")
	}
	if sockets, present := raw["unixSockets"]; present && sockets != nil {
		declaration.unixSockets = capabilityRuntimeStrings(sockets, "Pi extension runtime.unixSockets")
	}
	return declaration
}

// capabilityRuntimeStrings reads one array of nonempty strings.
func capabilityRuntimeStrings(value any, label string) []string {
	list, ok := value.([]any)
	if !ok {
		Raise("capability_unavailable", label+" must be an array of nonempty strings")
	}
	out := []string{}
	for _, item := range list {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			Raise("capability_unavailable", label+" must be an array of nonempty strings")
		}
		out = append(out, strings.TrimSpace(text))
	}
	return out
}

// capabilityRuntimePlaceholders are the values one runtime declaration may reference.
func capabilityRuntimePlaceholders(snapshot string, workspace string, scratchDir string, stateDir string, secrets CapabilitySecrets) map[string]string {
	placeholders := map[string]string{
		"HOME":       capabilityHomeDir(),
		"uid":        fmt.Sprintf("%d", os.Getuid()),
		"pid":        fmt.Sprintf("%d", os.Getpid()),
		"snapshot":   snapshot,
		"workspace":  workspace,
		"scratchDir": scratchDir,
		"stateDir":   stateDir,
	}
	for name, value := range secrets {
		placeholders[name] = value
	}
	return placeholders
}

// capabilityHomeDir is the home directory of the running user.
func capabilityHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// capabilityExpandRuntimeValue expands the environment references of one value.
func capabilityExpandRuntimeValue(value string, placeholders map[string]string, label string) string {
	expanded := capabilityEnvironmentPattern.ReplaceAllStringFunc(value, func(match string) string {
		name := capabilityEnvironmentPattern.FindStringSubmatch(match)[1]
		if name == "" {
			name = capabilityEnvironmentPattern.FindStringSubmatch(match)[2]
		}
		replacement, ok := placeholders[name]
		if !ok {
			replacement, ok = os.LookupEnv(name)
		}
		if !ok {
			Raise("capability_unavailable", label+" requires environment variable "+name)
		}
		return replacement
	})
	if strings.Contains(expanded, "$") {
		Raise("capability_unavailable", label+" contains an invalid environment reference")
	}
	return expanded
}

// capabilityRuntimePath resolves one runtime path against the snapshot.
func capabilityRuntimePath(value string, snapshot string, placeholders map[string]string, label string) string {
	expanded := capabilityExpandRuntimeValue(value, placeholders, label)
	if filepath.IsAbs(expanded) {
		return filepath.Clean(expanded)
	}
	return filepath.Clean(filepath.Join(snapshot, expanded))
}

// capabilityResolvedCommand is one command a runtime declaration resolved.
type capabilityResolvedCommand struct {
	command   string
	path      string
	readPaths []string
}

// capabilityResolveRuntimeCommand resolves one command a runtime declaration names.
func capabilityResolveRuntimeCommand(command string, snapshot string) capabilityResolvedCommand {
	execPath, electron := GraphNodeRuntime(nil)
	if command == "node" {
		return capabilityResolvedCommand{command: command, path: execPath, readPaths: NodeReadPaths(execPath, electron)}
	}
	candidate := ""
	if filepath.IsAbs(command) {
		candidate = command
	} else if strings.ContainsAny(command, "/\\") {
		candidate = filepath.Clean(filepath.Join(snapshot, command))
	} else {
		for _, directory := range capabilityLocalCommandSearchDirectories(command) {
			path := filepath.Clean(filepath.Join(directory, command))
			if capabilityIsExecutable(path) {
				candidate = path
				break
			}
		}
	}
	if candidate == "" {
		Raise("capability_unavailable", "Pi extension runtime command "+command+" was not found on PATH")
	}
	if !capabilityIsExecutable(candidate) {
		Raise("capability_unavailable", "Pi extension runtime command "+command+" is not executable")
	}
	target := capabilityRealPath(candidate)
	return capabilityResolvedCommand{
		command: command,
		path:    filepath.Clean(candidate),
		readPaths: capabilityUniqueStrings([]string{
			filepath.Dir(filepath.Clean(candidate)),
			filepath.Dir(target),
		}),
	}
}

// capabilityIsExecutable reports whether a path may be executed.
func capabilityIsExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

// capabilityRealPath resolves a path, falling back to its cleaned form.
func capabilityRealPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return resolved
}

// capabilityUniqueStrings keeps the first occurrence of every value.
func capabilityUniqueStrings(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// capabilityResolvedRuntime is the runtime one Pi extension resolved.
type capabilityResolvedRuntime struct {
	env                      map[string]string
	readPaths                []string
	writePaths               []string
	networkDomains           []string
	allowUnrestrictedNetwork bool
	allowLocalBinding        bool
	unixSockets              []string
}

// capabilityResolvePiExtensionRuntime resolves the runtime declaration of one manifest.
func capabilityResolvePiExtensionRuntime(manifest map[string]any, snapshot string, workspace string, scratchDir string, stateDir string, secrets CapabilitySecrets) *capabilityResolvedRuntime {
	declaration := capabilityRuntimeDeclaration(manifest["runtime"])
	if declaration == nil {
		return nil
	}
	placeholders := capabilityRuntimePlaceholders(snapshot, workspace, scratchDir, stateDir, secrets)
	readPaths := []string{}
	writePaths := []string{}
	networkDomains := []string{}
	unixSockets := []string{}
	env := map[string]string{}
	for name, value := range declaration.env {
		env[name] = capabilityExpandRuntimeValue(value, placeholders, "Pi extension runtime.env."+name)
	}
	for _, value := range declaration.readPaths {
		readPaths = append(readPaths, capabilityRuntimePath(value, snapshot, placeholders, "Pi extension runtime.readPaths"))
	}
	for _, value := range declaration.writePaths {
		writePaths = append(writePaths, capabilityRuntimePath(value, snapshot, placeholders, "Pi extension runtime.writePaths"))
	}
	for _, value := range declaration.unixSockets {
		path := capabilityRuntimePath(value, snapshot, placeholders, "Pi extension runtime.unixSockets")
		unixSockets = append(unixSockets, path)
		readPaths = append(readPaths, path)
		writePaths = append(writePaths, path)
	}
	for _, value := range declaration.networkDomains {
		networkDomains = append(networkDomains, capabilityExpandRuntimeValue(value, placeholders, "Pi extension runtime.networkDomains"))
	}
	for _, command := range declaration.commands {
		resolved := capabilityResolveRuntimeCommand(command, snapshot)
		readPaths = append(readPaths, resolved.readPaths...)
		pathEntries := append([]string{}, resolved.readPaths...)
		if existing, ok := env["PATH"]; ok && existing != "" {
			pathEntries = append(pathEntries, strings.Split(existing, ":")...)
		}
		env["PATH"] = strings.Join(capabilityUniqueStrings(pathEntries), ":")
	}
	return &capabilityResolvedRuntime{
		env: env, readPaths: capabilityUniqueStrings(readPaths), writePaths: capabilityUniqueStrings(writePaths),
		networkDomains:           capabilityUniqueStrings(networkDomains),
		allowUnrestrictedNetwork: declaration.networkAccess == "unrestricted",
		allowLocalBinding:        declaration.allowLocalBinding,
		unixSockets:              capabilityUniqueStrings(unixSockets),
	}
}

// PiExtensionCacheDir is where the SDK installs Pi extension sources. One cache per Graph home
// rather than per state directory: the install is a download cache for the declared source, so a
// second daemon (or a test) reuses it instead of installing the same package again.
func PiExtensionCacheDir(catalog *Catalog) string {
	root := ""
	if catalog != nil {
		root = catalog.CapabilityRootPath()
	}
	if root != "" {
		return filepath.Join(filepath.Dir(root), "extensions")
	}
	return filepath.Join(os.TempDir(), "graph-pi-extensions")
}

// SyncCapabilityVersion reports the version the source actually resolved to: the manifest's
// `version` follows the source instead of decaying into a stale pin.
func SyncCapabilityVersion(snapshot string, version *string) {
	if version == nil || *version == "" {
		return
	}
	file := filepath.Join(snapshot, "capability.json")
	defer func() {
		// A manifest we cannot rewrite must never fail the load that triggered it.
		_ = recover()
	}()
	content, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var manifest map[string]any
	if err := json.Unmarshal(content, &manifest); err != nil {
		return
	}
	if manifest == nil {
		manifest = map[string]any{}
	}
	if current, _ := manifest["version"].(string); current == *version {
		return
	}
	manifest["version"] = *version
	encoded, err := json.Marshal(CanonicalJSON(manifest))
	if err != nil {
		return
	}
	_ = os.WriteFile(file, append(encoded, '\n'), 0o644)
}

// capabilityManifestOf reads the manifest of one snapshot.
func capabilityManifestOf(snapshot string) map[string]any {
	content, err := os.ReadFile(filepath.Join(snapshot, "capability.json"))
	if err != nil {
		Raise("capability_unavailable", "Capability manifest is unreadable: "+err.Error())
	}
	var manifest map[string]any
	if err := json.Unmarshal(content, &manifest); err != nil {
		Raise("capability_unavailable", "Capability manifest is unreadable: "+err.Error())
	}
	if manifest == nil {
		manifest = map[string]any{}
	}
	return manifest
}

// capabilityPromptText reads one prompt file of a snapshot.
func capabilityPromptText(snapshot string, name string) string {
	content, err := os.ReadFile(filepath.Join(snapshot, name))
	if err != nil {
		Raise("capability_unavailable", "Prompt "+snapshot+" requires a nonempty "+name+": "+err.Error())
	}
	if strings.TrimSpace(string(content)) == "" {
		Raise("capability_unavailable", "Prompt "+snapshot+" requires a nonempty "+name+": empty prompt")
	}
	return string(content)
}

// capabilityFileDigest is the sha256 of one file.
func capabilityFileDigest(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// capabilityTextDigest is the sha256 of one text.
func capabilityTextDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// capabilityExtensionEntry is the entry file one manifest names.
func capabilityExtensionEntry(manifest map[string]any, snapshot string) string {
	value := "./index.mjs"
	if declared, ok := manifest["entry"].(string); ok && strings.TrimSpace(declared) != "" {
		value = declared
	}
	path := value
	if !filepath.IsAbs(path) {
		path = filepath.Clean(filepath.Join(snapshot, path))
	}
	if path != snapshot && !strings.HasPrefix(path, snapshot+string(filepath.Separator)) {
		Raise("capability_unavailable", "Capability entry "+value+" must stay inside its snapshot")
	}
	return path
}

// capabilitySkillMetadata reads the frontmatter of one skill file.
func capabilitySkillMetadata(text string) map[string]string {
	values := map[string]string{}
	front := capabilityFrontmatter(text)
	if front == "" {
		return values
	}
	for _, line := range strings.Split(front, "\n") {
		index := strings.Index(line, ":")
		if index <= 0 {
			continue
		}
		name := strings.TrimSpace(line[:index])
		if !capabilityVariablePattern.MatchString(name) {
			continue
		}
		raw := strings.TrimSpace(line[index+1:])
		if len(raw) >= 2 && (raw[0] == '\'' || raw[0] == '"') && raw[len(raw)-1] == raw[0] {
			raw = raw[1 : len(raw)-1]
		}
		if raw != "" {
			values[name] = raw
		}
	}
	return values
}

// capabilityFrontmatter reads the YAML frontmatter of one skill file.
func capabilityFrontmatter(text string) string {
	trimmed := strings.TrimPrefix(text, "\ufeff")
	if !strings.HasPrefix(trimmed, "---") {
		return ""
	}
	rest := strings.TrimPrefix(trimmed, "---")
	rest = strings.TrimPrefix(rest, "\r")
	rest = strings.TrimPrefix(rest, "\n")
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return ""
	}
	return strings.TrimSuffix(rest[:end], "\r")
}

// capabilityResolveManifestDomains resolves the host patterns one manifest declares.
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

// capabilityDomainPattern normalizes one host pattern, reporting an invalid one.
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

// capabilityManifestNetworkDomains resolves the host patterns one manifest declares.
func capabilityManifestNetworkDomains(manifest map[string]any, granted []string, secrets CapabilitySecrets) []string {
	return capabilityResolveManifestDomains(manifest["networkDomains"], "MCP networkDomains", granted, secrets)
}

// capabilityProvisioningPlan is how one capability provisions its package.
type capabilityProvisioningPlan struct {
	manager   string
	domains   []string
	root      string
	readyFile string
	key       string
}

// capabilityProvisioningPlanFor plans the provisioning of one manifest.
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

// capabilityProvisioningEnvironment is the environment one provisioning phase needs.
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

// capabilityRemoteConnection is the exchange one remote MCP capability uses.
func capabilityRemoteConnection(manifest map[string]any, gate SendGate, mcpDomains []string, secrets CapabilitySecrets) McpExchange {
	declared, ok := manifest["url"].(string)
	if !ok || strings.TrimSpace(declared) == "" {
		Raise("capability_unavailable", "An MCP capability requires capability.json with an absolute command or a remote url")
	}
	parsed, err := url.Parse(declared)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		Raise("capability_unavailable", "Remote MCP url is invalid: "+declared)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		Raise("capability_unavailable", "Remote MCP supports http and https, not "+parsed.Scheme+":")
	}
	if parsed.User != nil {
		Raise("capability_unavailable", "Remote MCP urls cannot embed credentials")
	}
	domains := capabilityManifestNetworkDomains(manifest, append(append([]string{}, mcpDomains...), parsed.Hostname()), secrets)
	if !AllowedDomain(domains, parsed.Hostname()) {
		Raise("capability_unavailable", "Remote MCP host "+parsed.Hostname()+" is not in the granted MCP domains")
	}
	timeout := 30000
	return HttpExchange(HttpEndpoint{
		Gate:      gate,
		Url:       parsed.String(),
		Headers:   HeaderValues(manifest["headers"], manifest["headersEnv"], secrets),
		TimeoutMs: &timeout,
	})
}

// NodeReadPaths are the read paths a sandboxed helper needs to start the Node runtime itself.
// Inside a packaged Electron app `process.execPath` is the bundle binary, and
// loading it needs the sibling `Frameworks` directory, not just `MacOS`.
func NodeReadPaths(execPath string, electron string) []string {
	macos := filepath.Dir(execPath)
	if electron != "" {
		return []string{macos, filepath.Dir(macos)}
	}
	return []string{macos}
}

// capabilityLocalNodeReadPaths are the read paths the local Node runtime needs.
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

// capabilityGrants are the canonical paths one sandboxed helper may use.
type capabilityGrants struct {
	workspace  string
	scratchDir string
}

// capabilityRunGrants canonicalizes the grants one helper runs with.
func capabilityRunGrants(workspace string, scratchDir string) capabilityGrants {
	// The verified OS sandbox requires canonical, already-existing grants.
	canonicalWorkspace := capabilityRealPath(workspace)
	if err := os.MkdirAll(scratchDir, 0o700); err != nil {
		panic(err)
	}
	return capabilityGrants{workspace: canonicalWorkspace, scratchDir: capabilityRealPath(scratchDir)}
}

// capabilityBindingKey identifies one binding of one role.
func capabilityBindingKey(bound CapabilityBinding, role string) string {
	return bound.Id + "@" + bound.Version + ":" + role
}

// capabilityStableFact is the projection one load fact contributes to a digest.
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

// capabilityMapValue reads one optional value out of a fact view.
func capabilityMapValue(record map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, present := record[key]; present {
			return value
		}
	}
	return nil
}

// capabilityMapList reads one optional list out of a fact view.
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

// capabilityLocalConnectionInput is one local MCP connection request.
type capabilityLocalConnectionInput struct {
	executor                 capabilityRestrictedExecutor
	gate                     SendGate
	manifest                 map[string]any
	snapshot                 string
	workspace                string
	scratchDir               string
	readOnly                 bool
	networkDomains           []string
	allowUnrestrictedNetwork bool
	access                   *ResolvedAccessPolicy
	secrets                  CapabilitySecrets
	provisioning             *capabilityProvisioningPlan
	provisioningPhase        string
	timeoutMs                int
	hostCommands             bool
}

// capabilityLocalConnection opens one local MCP connection.
func capabilityLocalConnection(input capabilityLocalConnectionInput) McpExchange {
	resolved := capabilityResolveLocalMcpCommand(input.manifest["command"], input.hostCommands)
	args := []string{}
	if declared, ok := input.manifest["args"].([]any); ok {
		for _, value := range declared {
			if text, ok := value.(string); ok {
				args = append(args, text)
			}
		}
	}
	grants := capabilityRunGrants(input.workspace, input.scratchDir)
	env := map[string]string{}
	for name, value := range EnvironmentValues(input.manifest["env"], input.secrets) {
		env[name] = value
	}
	provisioningPaths := []string{}
	if input.provisioning != nil {
		for name, value := range capabilityProvisioningEnvironment(input.provisioning, input.provisioningPhase) {
			env[name] = value
		}
		provisioningPaths = append(provisioningPaths, input.provisioning.root)
	}
	protectedPathExceptions := append([]string{input.snapshot}, resolved.readPaths...)
	protectedPathExceptions = append(protectedPathExceptions, provisioningPaths...)
	readPaths := append([]string{input.snapshot}, resolved.readPaths...)
	readPaths = append(readPaths, provisioningPaths...)
	writePaths := []string{}
	if input.readOnly {
		writePaths = append(writePaths, grants.scratchDir)
	} else {
		writePaths = append(writePaths, grants.workspace, grants.scratchDir)
	}
	writePaths = append(writePaths, provisioningPaths...)
	endpoint := StdioEndpoint{
		Executor:   input.executor,
		Gate:       input.gate,
		Cwd:        grants.workspace,
		ScratchDir: grants.scratchDir,
		Command:    resolved.executable,
		Args:       append(append([]string{}, resolved.argsPrefix...), capabilityResolveArgs(input.snapshot, args, input.secrets)...),
		Env:        env,
		ReadPaths:  readPaths,
		// Discussion turns may read the business directory but only write scratch.
		WritePaths: writePaths,
	}
	if len(env) > 0 {
		endpoint.Env = env
	} else {
		endpoint.Env = nil
	}
	if len(provisioningPaths) > 0 {
		endpoint.AllowGitMetadataWrites = provisioningPaths
	}
	timeout := input.timeoutMs
	if timeout == 0 {
		timeout = 30000
	}
	endpoint.TimeoutMs = &timeout
	if len(input.networkDomains) > 0 {
		endpoint.NetworkDomains = input.networkDomains
	}
	endpoint.AllowUnrestrictedNetwork = input.allowUnrestrictedNetwork
	if input.access != nil {
		filesystem := "bounded"
		if input.access.Filesystem.Read == "host" || input.access.Filesystem.Write == "host" {
			filesystem = "host"
		}
		endpoint.Filesystem = filesystem
		endpoint.ProtectedPaths = input.access.ProtectedPaths
		if len(protectedPathExceptions) > 0 {
			endpoint.ProtectedPathExceptions = protectedPathExceptions
		}
		endpoint.AllowGitMetadataWritesAll = input.access.Filesystem.GitMetadata == "writable"
		endpoint.AllowLocalBinding = input.access.PiExtensions.LocalBinding
		endpoint.AllowAllUnixSockets = input.access.PiExtensions.UnixSockets == "all"
		endpoint.AllowAppleEvents = input.access.PiExtensions.AppleEvents
	}
	return StdioExchange(endpoint)
}

// capabilityResolveArgs expands the manifest arguments of one local MCP command.
func capabilityResolveArgs(snapshot string, args []string, secrets CapabilitySecrets) []string {
	out := []string{}
	for _, arg := range args {
		out = append(out, ResolveMcpArg(snapshot, arg, secrets))
	}
	return out
}

// capabilityEnsureMcpProvisioned provisions one local MCP capability when it needs it.
func capabilityEnsureMcpProvisioned(gate SendGate, manifest map[string]any, snapshot string, workspace string, scratchDir string, secrets CapabilitySecrets, runtimeDomains []string, hostCommands bool, allowUnrestrictedNetwork bool, access *ResolvedAccessPolicy) (*capabilityProvisioningPlan, error) {
	plan := capabilityProvisioningPlanFor(manifest, snapshot, secrets)
	if plan == nil {
		return nil, nil
	}
	if err := os.MkdirAll(plan.root, 0o700); err != nil {
		return nil, err
	}
	if _, err := os.Stat(plan.readyFile); err == nil {
		return plan, nil
	}
	lease := AcquireRestrictedExecutor()
	executor, ok := capabilityRestrictedExecutorOf(lease.Executor)
	if !ok {
		return nil, fmt.Errorf("the restricted executor does not run restricted commands")
	}
	defer lease.Release()
	connection := capabilityLocalConnection(capabilityLocalConnectionInput{
		executor: executor, gate: gate, manifest: manifest, snapshot: snapshot,
		workspace: workspace, scratchDir: scratchDir, secrets: secrets,
		provisioning: plan, provisioningPhase: "provision",
		networkDomains:           capabilityUniqueStrings(append(append([]string{}, plan.domains...), runtimeDomains...)),
		timeoutMs:                120000,
		hostCommands:             hostCommands,
		allowUnrestrictedNetwork: allowUnrestrictedNetwork,
		access:                   access,
	})
	if err := capabilityListMcpTools(connection); err != nil {
		return nil, fmt.Errorf("%s provisioning failed: %s", plan.manager, err.Error())
	}
	if err := os.WriteFile(plan.readyFile, []byte(plan.key+"\n"), 0o600); err != nil {
		return nil, err
	}
	return plan, nil
}

// capabilityListMcpTools reads the tools one MCP server lists.
func capabilityListMcpTools(connection McpExchange) error {
	defer func() {
		_ = recover()
	}()
	ListMcpTools(connection)
	return nil
}

// capabilityLocalCommandSearchDirectories are the directories one command is looked up in.
func capabilityLocalCommandSearchDirectories(command string) []string {
	configured := []string{}
	for _, entry := range strings.Split(os.Getenv("PATH"), ":") {
		if entry != "" {
			configured = append(configured, entry)
		}
	}
	common := []string{
		filepath.Join(capabilityHomeDir(), ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	}
	preferred := common
	switch command {
	case "uvx":
		preferred = append([]string{filepath.Join(capabilityHomeDir(), ".local", "bin")}, common...)
	case "npx":
		preferred = append([]string{"/opt/homebrew/bin", "/usr/local/bin"}, common...)
	}
	return capabilityUniqueStrings(append(configured, preferred...))
}

// capabilityFindExecutable looks one command up on PATH.
func capabilityFindExecutable(command string) string {
	for _, directory := range capabilityLocalCommandSearchDirectories(command) {
		candidate := filepath.Clean(filepath.Join(directory, command))
		if capabilityIsExecutable(candidate) {
			return candidate
		}
	}
	return ""
}

// capabilityResolvedLocalCommand is one local MCP command the loader resolved.
type capabilityResolvedLocalCommand struct {
	executable string
	argsPrefix []string
	readPaths  []string
}

// capabilityResolveLocalMcpCommand resolves the command one local MCP manifest names.
func capabilityResolveLocalMcpCommand(value any, hostCommands bool) capabilityResolvedLocalCommand {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		Raise("capability_unavailable", "A local MCP capability requires capability.json with a command")
	}
	command := strings.TrimSpace(text)
	execPath, electron := GraphNodeRuntime(nil)
	if command == "node" {
		return capabilityResolvedLocalCommand{
			executable: execPath, argsPrefix: []string{},
			readPaths: capabilityLocalNodeReadPaths(execPath, electron),
		}
	}
	if !hostCommands && !IsLocalMcpCommand(command) && !filepath.IsAbs(command) {
		Raise("capability_unavailable", "A local MCP command must be one of "+strings.Join(LOCAL_MCP_COMMANDS, ", ")+" or an absolute executable path")
	}
	candidate := command
	if !filepath.IsAbs(command) {
		candidate = capabilityFindExecutable(command)
	}
	if candidate == "" {
		Raise("capability_unavailable", "Local MCP command \""+command+"\" was not found on PATH")
	}
	if !capabilityIsExecutable(candidate) {
		Raise("capability_unavailable", "Local MCP command \""+command+"\" is not executable")
	}
	target := capabilityRealPath(candidate)
	baseReadPaths := capabilityUniqueStrings([]string{filepath.Dir(candidate), filepath.Dir(target)})
	if command == "npx" {
		return capabilityResolvedLocalCommand{
			executable: execPath, argsPrefix: []string{target},
			// npx-cli.js loads npm's package files relative to its real path.
			readPaths: capabilityUniqueStrings(append(append([]string{}, capabilityLocalNodeReadPaths(execPath, electron)...),
				append(baseReadPaths, filepath.Dir(filepath.Dir(execPath)), filepath.Dir(filepath.Dir(target)))...)),
		}
	}
	return capabilityResolvedLocalCommand{executable: candidate, argsPrefix: []string{}, readPaths: baseReadPaths}
}

// capabilityExtensionConnectionInput is one Graph extension connection request.
type capabilityExtensionConnectionInput struct {
	executor   capabilityRestrictedExecutor
	gate       SendGate
	manifest   map[string]any
	snapshot   string
	workspace  string
	scratchDir string
	readOnly   bool
	access     *ResolvedAccessPolicy
}

// capabilityExtensionConnection opens one Graph extension connection.
func capabilityExtensionConnection(input capabilityExtensionConnectionInput) McpExchange {
	declared := "./index.mjs"
	if value, ok := input.manifest["entry"].(string); ok && strings.TrimSpace(value) != "" {
		declared = value
	}
	entry := declared
	if !filepath.IsAbs(entry) {
		entry = filepath.Clean(filepath.Join(input.snapshot, entry))
	}
	if entry != input.snapshot && !strings.HasPrefix(entry, input.snapshot+string(filepath.Separator)) {
		Raise("capability_unavailable", "Extension entry "+declared+" must stay inside the snapshot")
	}
	if _, err := os.Stat(entry); err != nil {
		Raise("capability_unavailable", "Extension entry "+declared+" does not exist")
	}
	grants := capabilityRunGrants(input.workspace, input.scratchDir)
	execPath, electron := GraphNodeRuntime(nil)
	worker := capabilityExtensionWorkerPath()
	writePaths := []string{grants.workspace, grants.scratchDir}
	if input.readOnly {
		writePaths = []string{grants.scratchDir}
	}
	endpoint := StdioEndpoint{
		Executor:   input.executor,
		Gate:       input.gate,
		Cwd:        grants.workspace,
		ScratchDir: grants.scratchDir,
		Command:    execPath,
		Args:       []string{worker, capabilityRealPath(entry)},
		ReadPaths:  append(append([]string{input.snapshot}, NodeReadPaths(execPath, electron)...), filepath.Dir(worker)),
		// Extension register() and every tool call share this restriction, so a
		// bound extension cannot write business files during discussion.
		WritePaths: writePaths,
	}
	if input.access != nil {
		filesystem := "bounded"
		if input.access.Filesystem.Read == "host" || input.access.Filesystem.Write == "host" {
			filesystem = "host"
		}
		endpoint.Filesystem = filesystem
		endpoint.ProtectedPaths = input.access.ProtectedPaths
		endpoint.ProtectedPathExceptions = []string{input.snapshot, entry, filepath.Dir(entry)}
		endpoint.AllowGitMetadataWritesAll = input.access.Filesystem.GitMetadata == "writable"
		endpoint.AllowLocalBinding = input.access.PiExtensions.LocalBinding
		endpoint.AllowAllUnixSockets = input.access.PiExtensions.UnixSockets == "all"
		endpoint.AllowAppleEvents = input.access.PiExtensions.AppleEvents
	}
	return StdioExchange(endpoint)
}

// capabilityExtensionWorkerPath is the Node helper that loads one extension.
func capabilityExtensionWorkerPath() string {
	return filepath.Join(ApplicationRoot, "src", "runtime", "extension-worker.mjs")
}

// capabilityAuthorization is the grant state one MCP capability is loaded under.
type capabilityAuthorization struct {
	grants               []string
	onPermissionRequired func(CapabilityPermissionRequest)
}

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

// LoadCapabilities loads the capabilities bound by an Agent definition version.
//
// Skills become Pi resources and a read-only tool; local MCP servers and
// extensions run one restricted process per call; remote MCP talks to a host in
// the runtime's granted domains. Every tool call passes the same send gate as
// model calls.
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
	// Actual load facts: later projections must never guess these from catalog
	// status alone.
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
		// Unpublished definitions keep briefing-only behavior.
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
	// Bindings the definition declares itself are a promise to the user, so they stay fail-closed.
	// The rest come from base capabilities: a convenience layer nobody asked for, which must never
	// be able to stop a session (see the 2026-09-25 incident).
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
	if input.Access != nil && input.Access.Network == "unrestricted" {
		state.runtimeNetworkDomains = []string{}
		state.runtimeUnrestrictedNetwork = true
	}
	if input.Access != nil && input.Access.PiExtensions.LocalBinding {
		state.runtimeLocalBinding = true
	}
	return finish()
}

// capabilityFailureMessage reads the message of one load failure.
func capabilityFailureMessage(failure any) string {
	if err, ok := failure.(*RuntimeError); ok && err != nil {
		return err.Message
	}
	if err, ok := failure.(error); ok {
		return err.Error()
	}
	return fmt.Sprintf("%v", failure)
}

// capabilityOptionalString turns an empty text into an absent value.
func capabilityOptionalString(value string) *string {
	if value == "" {
		return nil
	}
	text := value
	return &text
}

// capabilityLoadOne loads one bound capability. It returns the facts it produced, or the
// failure that stopped it.
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
	if record.Kind != CapabilityKindMCP && record.Kind != CapabilityKindExtension {
		Raise("capability_unsupported", "Capability kind "+record.Kind+" is not loadable")
	}
	manifest := capabilityManifestOf(snapshot)
	var connection McpExchange
	var authorization *capabilityAuthorization
	loadedReason := ""
	var networkDomains []string
	var networkAccess string
	var provisioning *capabilityProvisioningPlan
	if record.Kind == CapabilityKindExtension {
		lease := AcquireRestrictedExecutor()
		executor, ok := capabilityRestrictedExecutorOf(lease.Executor)
		if !ok {
			Raise("capability_unavailable", "the restricted executor does not run restricted commands")
		}
		state.releases = append(state.releases, lease.Release)
		connection = capabilityExtensionConnection(capabilityExtensionConnectionInput{
			executor: executor, gate: input.Gate, manifest: manifest, snapshot: snapshot,
			workspace: input.Workspace, scratchDir: input.ScratchDir, readOnly: input.ReadOnly, access: input.Access,
		})
		if input.ReadOnly {
			loadedReason = "只读讨论模式：本地扩展在 scratch 只读范围加载"
		}
	} else if _, ok := manifest["command"].(string); ok {
		fullNetwork := input.Access != nil && input.Access.Network == "unrestricted"
		if !fullNetwork && manifest["networkAccess"] != nil && manifest["networkAccess"] != "unrestricted" {
			Raise("capability_unavailable", "MCP networkAccess must be \"unrestricted\"")
		}
		if fullNetwork || manifest["networkAccess"] == "unrestricted" {
			networkAccess = "unrestricted"
		}
		if !fullNetwork && networkAccess != "" && manifest["networkDomains"] != nil {
			Raise("capability_unavailable", "MCP cannot combine networkDomains with unrestricted network access")
		}
		if networkAccess == "" {
			networkDomains = capabilityManifestNetworkDomains(manifest, input.McpDomains, input.Secrets)
		} else {
			networkDomains = []string{}
		}
		if len(networkDomains) > 0 || networkAccess != "" {
			authorization = &capabilityAuthorization{grants: input.Grants, onPermissionRequired: input.OnPermissionRequired}
		}
		plan, err := capabilityEnsureMcpProvisioned(input.Gate, manifest, snapshot, input.Workspace, input.ScratchDir, input.Secrets, networkDomains,
			input.Access != nil && input.Access.Commands == "host", fullNetwork, input.Access)
		if err != nil {
			Raise("capability_unavailable", err.Error())
		}
		provisioning = plan
		lease := AcquireRestrictedExecutor()
		executor, ok := capabilityRestrictedExecutorOf(lease.Executor)
		if !ok {
			Raise("capability_unavailable", "the restricted executor does not run restricted commands")
		}
		state.releases = append(state.releases, lease.Release)
		connection = capabilityLocalConnection(capabilityLocalConnectionInput{
			executor: executor, gate: input.Gate, manifest: manifest, snapshot: snapshot,
			workspace: input.Workspace, scratchDir: input.ScratchDir, readOnly: input.ReadOnly,
			networkDomains: networkDomains, allowUnrestrictedNetwork: networkAccess != "",
			access: input.Access, secrets: input.Secrets, provisioning: provisioning, provisioningPhase: "runtime",
			hostCommands: input.Access != nil && input.Access.Commands == "host",
		})
		if input.ReadOnly {
			loadedReason = "只读讨论模式：本地能力在只读范围加载"
		}
	} else {
		if manifest["networkAccess"] != nil {
			Raise("capability_unavailable", "MCP networkAccess is only valid for local MCP commands")
		}
		authorization = &capabilityAuthorization{grants: input.Grants, onPermissionRequired: input.OnPermissionRequired}
		connection = capabilityRemoteConnection(manifest, input.Gate, input.McpDomains, input.Secrets)
		remote, _ := manifest["url"].(string)
		parsed, err := url.Parse(remote)
		hostname := ""
		if err == nil {
			hostname = parsed.Hostname()
		}
		networkDomains = capabilityManifestNetworkDomains(manifest, append(append([]string{}, input.McpDomains...), hostname), input.Secrets)
	}
	discovered := ListMcpTools(connection)
	if authorization != nil {
		// Binding a capability to the Agent definition is the default
		// authorization boundary. Keep explicit task grants as additional
		// evidence, but do not require a second per-tool approval for tools
		// that are already present in the bound, versioned capability.
		grants := append([]string{}, authorization.grants...)
		for _, tool := range discovered {
			grants = append(grants, McpGrant(binding.bound.Id, tool.Name))
		}
		sort.Strings(grants)
		authorization.grants = capabilityUniqueStrings(grants)
	}
	state.tools = append(state.tools, capabilityTools(connection, discovered, binding.bound.Id, binding.bound.Version, authorization)...)
	// "Loaded" is discovery; "executable" reflects the effective grants
	// assembled for this operation.
	executable := true
	grantReason := ""
	if authorization != nil && len(discovered) > 0 {
		granted := 0
		for _, tool := range discovered {
			if capabilityStringListHas(authorization.grants, McpGrant(binding.bound.Id, tool.Name)) {
				granted++
			}
		}
		executable = granted > 0
		if granted == 0 {
			grantReason = "已加载 " + itoa(len(discovered)) + " 个工具，当前无任务授权（例如 " + McpGrant(binding.bound.Id, discovered[0].Name) + "），调用会被权限门拒绝"
		} else if granted < len(discovered) {
			grantReason = "已加载 " + itoa(len(discovered)) + " 个工具，其中 " + itoa(granted) + " 个获授权，其余调用会被权限门拒绝"
		}
	} else if authorization != nil && len(discovered) == 0 {
		executable = false
		grantReason = "能力已连接但没有可调用工具"
	}
	fact := RuntimeCapabilityLoadFact{
		Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
		Loaded: true, Executable: executable,
	}
	if grantReason != "" {
		fact.Reason = capabilityOptionalString(grantReason)
	} else if loadedReason != "" {
		fact.Reason = capabilityOptionalString(loadedReason)
	}
	if len(discovered) > 0 {
		names := []string{}
		for _, tool := range discovered {
			names = append(names, capabilityMcpToolName(binding.bound.Id, tool.Name))
		}
		fact.Tools = names
	}
	if len(networkDomains) > 0 {
		fact.NetworkDomains = networkDomains
	}
	if networkAccess != "" {
		fact.NetworkAccess = networkAccess
	}
	if provisioning != nil {
		fact.Provisioning = &RuntimeCapabilityProvisioning{
			Manager: provisioning.manager, Domains: provisioning.domains, Path: provisioning.root,
		}
	}
	return []RuntimeCapabilityLoadFact{fact}, nil
}

// capabilityLoadPiExtension loads one Pi extension capability.
func capabilityLoadPiExtension(input CapabilityLoadInput, binding capabilityBinding, record *CapabilityRecord, snapshot string, state *capabilityLoadState) ([]RuntimeCapabilityLoadFact, any) {
	if _, err := os.Stat(snapshot); err != nil {
		Raise("capability_unavailable", "Pi extension "+binding.bound.Id+"@"+binding.bound.Version+" has no snapshot")
	}
	manifest := capabilityManifestOf(snapshot)
	declared := capabilityDeclaredToolsFromManifest(manifest)
	source := ""
	if value, ok := manifest["source"].(string); ok && strings.TrimSpace(value) != "" {
		source = strings.TrimSpace(value)
	}
	loadedEntry := ""
	if source != "" {
		// A declared source is installed and resolved by the Pi SDK's own package manager, so
		// version ranges, git refs and the package's own `pi.extensions` list stay native.
		resolved, err := ResolvePiExtensionSource(PiExtensionSourceInput{
			Source: source, Cwd: input.Workspace, AgentDir: PiExtensionCacheDir(input.Catalog),
		})
		if err != nil {
			Raise("capability_unavailable", err.Error())
		}
		state.piExtensionPaths = append(state.piExtensionPaths, resolved.Entries...)
		state.readRoots = append(state.readRoots, resolved.ReadRoots...)
		if len(resolved.Entries) > 0 {
			loadedEntry = resolved.Entries[0]
		}
		SyncCapabilityVersion(snapshot, resolved.Version)
	} else {
		declaredEntry := "./index.mjs"
		if value, ok := manifest["entry"].(string); ok && strings.TrimSpace(value) != "" {
			declaredEntry = value
		}
		entry := declaredEntry
		if !filepath.IsAbs(entry) {
			entry = filepath.Clean(filepath.Join(snapshot, entry))
		}
		if entry != snapshot && !strings.HasPrefix(entry, snapshot+string(filepath.Separator)) {
			Raise("capability_unavailable", "Pi extension entry "+declaredEntry+" must stay inside its snapshot")
		}
		if _, err := os.Stat(entry); err != nil {
			Raise("capability_unavailable", "Pi extension entry "+declaredEntry+" does not exist")
		}
		state.piExtensionPaths = append(state.piExtensionPaths, entry)
		state.readRoots = append(state.readRoots, snapshot)
		loadedEntry = entry
	}
	for _, tool := range declared {
		state.piExtensionTools = append(state.piExtensionTools, tool.Name)
	}
	runtime := capabilityResolvePiExtensionRuntime(manifest, snapshot, input.Workspace, input.ScratchDir, filepath.Dir(input.ScratchDir), input.Secrets)
	if runtime != nil {
		for name, value := range runtime.env {
			state.env[name] = value
		}
		for _, path := range append(append([]string{}, runtime.writePaths...), runtime.unixSockets...) {
			if err := os.MkdirAll(path, 0o700); err != nil {
				Raise("capability_unavailable", err.Error())
			}
		}
		state.readRoots = append(state.readRoots, runtime.readPaths...)
		state.writeRoots = append(state.writeRoots, runtime.writePaths...)
		state.runtimeNetworkDomains = capabilityUniqueStrings(append(state.runtimeNetworkDomains, runtime.networkDomains...))
		state.runtimeUnixSockets = capabilityUniqueStrings(append(state.runtimeUnixSockets, runtime.unixSockets...))
		if runtime.allowUnrestrictedNetwork {
			state.runtimeUnrestrictedNetwork = true
		}
		if runtime.allowLocalBinding {
			state.runtimeLocalBinding = true
		}
	}
	commandState := "无"
	if runtime != nil && runtime.env["PATH"] != "" {
		commandState = "已解析"
	}
	networkState := "无"
	if runtime != nil {
		if runtime.allowUnrestrictedNetwork {
			networkState = "不受限"
		} else if len(runtime.networkDomains) > 0 {
			networkState = strings.Join(runtime.networkDomains, ", ")
		}
	}
	socketCount := 0
	if runtime != nil {
		socketCount = len(runtime.unixSockets)
	}
	reasons := []string{"独立 Pi 进程内加载；声明工具 " + itoa(len(declared)) + " 个"}
	if runtime != nil {
		reasons = append(reasons, "运行时声明：命令 "+commandState+"，网络 "+networkState+"，Unix socket "+itoa(socketCount))
	}
	fact := RuntimeCapabilityLoadFact{
		Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
		Loaded: true, Executable: true,
		Reason: capabilityOptionalString(strings.Join(reasons, "；")),
		Path:   capabilityOptionalString(loadedEntry),
	}
	if source != "" {
		fact.Source = capabilityOptionalString(source)
	}
	if len(declared) > 0 {
		names := []string{}
		for _, tool := range declared {
			names = append(names, tool.Name)
		}
		fact.Tools = names
	}
	if runtime != nil {
		envNames := []string{}
		for name := range runtime.env {
			envNames = append(envNames, name)
		}
		sort.Strings(envNames)
		var networkAccess any
		if runtime.allowUnrestrictedNetwork {
			networkAccess = "unrestricted"
		}
		fact.Runtime = map[string]any{
			"env": envNames, "readPaths": runtime.readPaths, "writePaths": runtime.writePaths,
			"networkDomains": runtime.networkDomains, "networkAccess": networkAccess,
			"allowLocalBinding": runtime.allowLocalBinding, "unixSockets": runtime.unixSockets,
		}
	}
	return []RuntimeCapabilityLoadFact{fact}, nil
}

// CapabilityPrompts builds the identity prompt from the exact loaded bundle.
// The generated tool section is authoritative even when a tool.md capability is bound.
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

// capabilityRuntimeError is one capability failure.
func capabilityRuntimeError(code string, message string) *RuntimeError {
	return &RuntimeError{Code: code, Message: message}
}

// capabilityRestrictedExecutor is the executor the MCP client runs commands with.
type capabilityRestrictedExecutor interface {
	Run(command RestrictedCommand) McpRunResult
}

// capabilityRestrictedExecutorOf adapts the executor one lease carries to the MCP reply shape.
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
