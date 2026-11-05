package graph

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// GRAPH_DESKTOP_BIN names the agent-desktop executable the host installed.
//
// It is the explicit way in, because the CLI is a host program and not a
// dependency of this repository: a packaged app and a test both have to be able
// to say which binary the capability runs instead of trusting PATH.
const GRAPH_DESKTOP_BIN_ENV = "GRAPH_DESKTOP_BIN"

// desktopRunLimit is how long one command may take. The CLI's own waits default
// to 30s, and a physical gesture that never lands must not hold the turn.
const desktopRunLimit = 120 * time.Second

// desktopEnvelopeLimit is how much of one envelope is accepted. A snapshot of a
// huge window is still one tool result; beyond this the answer says so instead
// of spending the turn's context on it.
const desktopEnvelopeLimit = 400_000

// desktopCommandName is the shape of an agent-desktop subcommand.
var desktopCommandName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// DesktopRun is what one agent-desktop process printed.
type DesktopRun struct {
	Stdout string
	Stderr string
	// Code is the exit status, or nil when the process was killed.
	Code *int
	// TimedOut reports a process that outlived the run limit and was killed.
	TimedOut bool
}

// AgentToolsDesktop is the computer-use capability of the host.
type AgentToolsDesktop struct {
	// Bin is the resolved agent-desktop executable.
	Bin string
	// Run executes one argument vector and returns what it printed.
	Run func(args []string) DesktopRun
}

// OpenDesktopTools resolves the host's agent-desktop, or nil when it has none.
//
// A host without the CLI declares no desktop tool at all: a tool that always
// fails would cost every session its schema characters for nothing.
func OpenDesktopTools(capabilityRoot string) *AgentToolsDesktop {
	bin := ResolveDesktopBinary(capabilityRoot)
	if bin == "" {
		return nil
	}
	return &AgentToolsDesktop{Bin: bin, Run: func(args []string) DesktopRun {
		return RunDesktopCommand(bin, args)
	}}
}

// ResolveDesktopBinary is GRAPH_DESKTOP_BIN when it names an executable, else
// the copy the capability library installed, else agent-desktop on PATH.
//
// The capability library comes before PATH on purpose: the library copy is the
// one the app installed and the one the user granted permissions to, and the
// macOS grant is bound to the path it was given.
func ResolveDesktopBinary(capabilityRoot string) string {
	declared := strings.TrimSpace(os.Getenv(GRAPH_DESKTOP_BIN_ENV))
	if desktopExecutable(declared) {
		return declared
	}
	if root := strings.TrimSpace(capabilityRoot); root != "" {
		for _, candidate := range desktopCapabilityBinaries(root) {
			if desktopExecutable(candidate) {
				return candidate
			}
		}
	}
	if found, err := exec.LookPath("agent-desktop"); err == nil {
		return found
	}
	return ""
}

// desktopCapabilityBinaries are the two shapes a capability install takes: the
// launcher the package links into `node_modules/.bin`, and the platform binary
// it launches, which is what `permissions --guide` was used to authorise.
func desktopCapabilityBinaries(root string) []string {
	packageDir := filepath.Join(root, "agent-desktop", "node_modules", "agent-desktop")
	return []string{
		filepath.Join(root, "agent-desktop", "node_modules", ".bin", "agent-desktop"),
		filepath.Join(packageDir, "bin", "agent-desktop-"+desktopPlatformSuffix()),
	}
}

// desktopPlatformSuffix is the platform key the package names its binaries with.
func desktopPlatformSuffix() string {
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	osName := runtime.GOOS
	if osName == "windows" {
		osName = "win32"
	}
	return osName + "-" + arch
}

// desktopExecutable reports a path that is a file this host may run.
func desktopExecutable(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

// RunDesktopCommand runs one command on the host.
//
// The process is not routed through the workspace command runner: that runner
// confines a command to a work copy, and a computer-use command has to reach the
// accessibility API of the user's session. The environment it inherits is built
// here for the same reason - the CLI needs HOME and its own documented
// AGENT_DESKTOP_* opt-ins, not the daemon's credentials.
func RunDesktopCommand(bin string, args []string) DesktopRun {
	command := exec.Command(bin, args...)
	command.Env = desktopEnvironment()
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return DesktopRun{Stderr: "agent-desktop could not start: " + err.Error()}
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case <-done:
		code := command.ProcessState.ExitCode()
		return DesktopRun{Stdout: stdout.String(), Stderr: stderr.String(), Code: &code}
	case <-time.After(desktopRunLimit):
		_ = command.Process.Kill()
		<-done
		return DesktopRun{Stdout: stdout.String(), Stderr: stderr.String(), TimedOut: true}
	}
}

// desktopEnvironment is the environment agent-desktop runs with on the host.
func desktopEnvironment() []string {
	environment := []string{}
	for _, name := range []string{"HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"} {
		if value, ok := os.LookupEnv(name); ok {
			environment = append(environment, name+"="+value)
		}
	}
	// AGENT_DESKTOP_HOME, AGENT_DESKTOP_SESSION and AGENT_DESKTOP_AGENT_ID are
	// the CLI's own documented opt-ins; the host passes them through so a user
	// (or a test) can point the capability at a state root of their choosing.
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "AGENT_DESKTOP_") {
			environment = append(environment, entry)
		}
	}
	return environment
}

// agentToolsDesktopHandlers are the handlers of the Desktop tool.
func agentToolsDesktopHandlers(input AgentToolsInput) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"desktop": func(id string, params map[string]any) any {
			return agentToolsDesktopResult(input, params)
		},
	}
}

// agentToolsDesktopResult runs one desktop command and answers with what the CLI
// printed.
func agentToolsDesktopResult(input AgentToolsInput, params map[string]any) any {
	desktop := input.Desktop
	if desktop == nil || desktop.Bin == "" {
		Raise("permission", "This host has no agent-desktop; install it or set "+GRAPH_DESKTOP_BIN_ENV)
	}
	command := strings.TrimSpace(agentToolsStringOrEmpty(params["command"]))
	if !desktopCommandName.MatchString(command) {
		panic(errors.New("command must be one agent-desktop subcommand, for example \"snapshot\""))
	}
	args := []string{}
	if raw, ok := params["args"].([]any); ok {
		for _, item := range raw {
			value := agentToolsString(item)
			if len(value) > 4_000 || strings.ContainsAny(value, "\x00\r\n") {
				panic(errors.New("Invalid desktop argument"))
			}
			// The flag is a decision, not a string: the tool owns it so that it
			// cannot arrive without the warning that goes with it.
			if value == "--headed" || strings.HasPrefix(value, "--headed=") {
				panic(errors.New("--headed is not an argument here: pass headed: true, and only for a gesture that has to be physical"))
			}
			args = append(args, value)
		}
	}
	// The permission question is answered before the target question: a command
	// that reads the accessibility tree has no target to name without the grant.
	if refusal := desktopPermissionProblem(desktop, command, desktopExecutionContextOf(input)); refusal != nil {
		return agentToolsText(stringifyJSON(refusal))
	}
	argv := append([]string{command}, args...)
	if agentToolsTruthy(params["headed"]) {
		argv = append(argv, "--headed")
	}
	run := desktop.Run(argv)
	envelope := strings.TrimRight(run.Stdout, "\n")
	if strings.TrimSpace(envelope) == "" {
		// The CLI always prints one envelope on stdout; an empty one means the
		// program itself did not finish, and stderr plus the exit status are the
		// only answer there is.
		if run.TimedOut {
			panic(errors.New("agent-desktop did not answer within " + itoa(int(desktopRunLimit/time.Second)) + "s"))
		}
		reason := strings.TrimSpace(run.Stderr)
		if reason == "" {
			reason = "agent-desktop printed nothing"
		}
		if run.Code != nil && *run.Code != 0 {
			reason += " (exit " + itoa(*run.Code) + ")"
		}
		panic(errors.New(reason))
	}
	if len(envelope) > desktopEnvelopeLimit {
		panic(errors.New("The desktop answer is larger than " + itoa(desktopEnvelopeLimit) + " characters"))
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(envelope), &record); err != nil {
		// Not an envelope: hand back exactly what the process printed. The CLI
		// owns its refusal text, and rewriting it would hide what happened.
		return agentToolsText(envelope)
	}
	// A refusal travels byte for byte: the code, the suggestion and the
	// disposition are what the model has to read to decide whether the call may
	// be repeated. The host never retries on its own - a repeated click is a
	// second click - so the field is the only thing that may authorize one.
	if ok, _ := record["ok"].(bool); !ok {
		return agentToolsText(envelope)
	}
	// The payload is withheld by default, for every command and not only the
	// content-bearing ones: the daemon keeps tool results beside the
	// conversation, so "the answer reached the model" and "the answer is in the
	// transcript" are the same fact. The caller opens the door with
	// include:"output" when it actually needs the tree or the text.
	if agentToolsDesktopWantsOutput(params) {
		return agentToolsText(envelope)
	}
	payload := desktopPayloadKinds[command]
	if payload == "" {
		payload = "the command's own answer"
	}
	digest := sha256.Sum256([]byte(envelope))
	return agentToolsText(stringifyJSON(map[string]any{
		"version": record["version"], "ok": true, "command": record["command"],
		"withheld": "output", "bytes": len(envelope), "sha256": hex.EncodeToString(digest[:]),
		"reason":  "the payload is " + payload,
		"include": `pass include:"output" to read the envelope`,
	}))
}

// desktopPermissionProblem is the refusal to answer before the command runs, or
// nil when the command does not need the accessibility tree or the grant is there.
//
// A probe that cannot be read is not a denial: the command runs and the CLI's own
// answer stands, rather than the tool inventing a cause it did not observe.
func desktopPermissionProblem(desktop *AgentToolsDesktop, command string, context desktopExecutionContext) map[string]any {
	if !desktopAccessibilityCommands[command] {
		return nil
	}
	probe := desktop.Run([]string{"permissions"})
	state, version := desktopAccessibilityState(probe.Stdout)
	if state == "" || state == "granted" {
		return nil
	}
	return desktopPermissionRefusal(command, state, version, context)
}

// desktopExecutionContext is where one permission reading was taken.
//
// `agent-desktop permissions` answers with the accessibility grant of the process
// that runs it, and macOS binds that grant to the environment rather than to the
// binary: inside the seatbelt profile the same executable the user granted reads
// `denied`. A refusal that names only the state therefore reports the place the
// reading came from as the user's own setting, and sends them to repair a grant
// that may already be there. The context travels with the refusal so the model
// can tell the two apart and ask for the command on the host instead.
type desktopExecutionContext struct {
	// Sandboxed reports a session whose commands run confined instead of on the host.
	Sandboxed bool
	// AccessMode is the policy mode the reading was taken under.
	AccessMode string
	// Role is the Agent role of the session (master, worker or reviewer).
	Role string
	// PolicyDigest identifies the access policy the reading was taken under.
	PolicyDigest string
}

// desktopExecutionContextOf reads the context out of the tool input.
//
// A session without a resolved policy is marked sandboxed: the tool cannot prove
// that the reading came from the host, and a reading it cannot place is not
// evidence of the host grant.
func desktopExecutionContextOf(input AgentToolsInput) desktopExecutionContext {
	context := desktopExecutionContext{Sandboxed: true, AccessMode: "unknown", Role: input.Role}
	if input.Access == nil {
		return context
	}
	context.AccessMode = string(input.Access.Mode)
	context.PolicyDigest = input.Access.Digest
	context.Sandboxed = !IsFullAccess(input.Access)
	return context
}

// details is the context block a refusal carries.
func (context desktopExecutionContext) details() map[string]any {
	evidence := "host"
	if context.Sandboxed {
		evidence = "sandbox"
	}
	return map[string]any{
		"sandbox": context.Sandboxed, "accessMode": context.AccessMode,
		"role": context.Role, "policyDigest": context.PolicyDigest,
		"probe": "agent-desktop permissions", "evidence": evidence,
	}
}

// desktopAccessibilityState reads the accessibility state and the protocol
// version out of one `permissions` envelope.
func desktopAccessibilityState(stdout string) (string, string) {
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimRight(stdout, "\n")), &record); err != nil {
		return "", ""
	}
	version, _ := record["version"].(string)
	data, _ := record["data"].(map[string]any)
	accessibility, _ := data["accessibility"].(map[string]any)
	state, _ := accessibility["state"].(string)
	return strings.TrimSpace(state), version
}

// agentToolsDesktopWantsOutput reports an explicit request for the payload.
func agentToolsDesktopWantsOutput(params map[string]any) bool {
	return strings.EqualFold(strings.TrimSpace(agentToolsStringOrEmpty(params["include"])), "output")
}

// desktopCapabilityRoot is where the capability library keeps its installs.
func desktopCapabilityRoot(catalog *Catalog) string {
	if catalog == nil {
		return ""
	}
	return catalog.CapabilityRootPath()
}
