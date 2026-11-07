package graph

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"crypto/sha256"
)

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

func capabilityHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

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

func capabilityRuntimePath(value string, snapshot string, placeholders map[string]string, label string) string {
	expanded := capabilityExpandRuntimeValue(value, placeholders, label)
	if filepath.IsAbs(expanded) {
		return filepath.Clean(expanded)
	}
	return filepath.Clean(filepath.Join(snapshot, expanded))
}

type capabilityResolvedCommand struct {
	command   string
	path      string
	readPaths []string
}

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

func capabilityIsExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

func capabilityRealPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return resolved
}

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

type capabilityResolvedRuntime struct {
	env                      map[string]string
	readPaths                []string
	writePaths               []string
	networkDomains           []string
	allowUnrestrictedNetwork bool
	allowLocalBinding        bool
	unixSockets              []string
}

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

func SyncCapabilityVersion(snapshot string, version *string) {
	if version == nil || *version == "" {
		return
	}
	file := filepath.Join(snapshot, "capability.json")
	defer func() {
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

func capabilityFileDigest(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func capabilityTextDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

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
