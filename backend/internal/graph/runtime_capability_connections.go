package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

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
