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

const GRAPH_DESKTOP_BIN_ENV = "GRAPH_DESKTOP_BIN"

const desktopRunLimit = 120 * time.Second

const desktopEnvelopeLimit = 400_000

var desktopCommandName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

type DesktopRun struct {
	Stdout string
	Stderr string
	Code *int
	TimedOut bool
}

type AgentToolsDesktop struct {
	Bin string
	Run func(args []string) DesktopRun
}

func OpenDesktopTools(capabilityRoot string) *AgentToolsDesktop {
	bin := ResolveDesktopBinary(capabilityRoot)
	if bin == "" {
		return nil
	}
	return &AgentToolsDesktop{Bin: bin, Run: func(args []string) DesktopRun {
		return RunDesktopCommand(bin, args)
	}}
}

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

func desktopCapabilityBinaries(root string) []string {
	packageDir := filepath.Join(root, "agent-desktop", "node_modules", "agent-desktop")
	return []string{
		filepath.Join(root, "agent-desktop", "node_modules", ".bin", "agent-desktop"),
		filepath.Join(packageDir, "bin", "agent-desktop-"+desktopPlatformSuffix()),
	}
}

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

func desktopExecutable(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

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

func desktopEnvironment() []string {
	environment := []string{}
	for _, name := range []string{"HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"} {
		if value, ok := os.LookupEnv(name); ok {
			environment = append(environment, name+"="+value)
		}
	}
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "AGENT_DESKTOP_") {
			environment = append(environment, entry)
		}
	}
	return environment
}

func agentToolsDesktopHandlers(input AgentToolsInput) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"desktop": func(id string, params map[string]any) any {
			return agentToolsDesktopResult(input, params)
		},
	}
}

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
			if value == "--headed" || strings.HasPrefix(value, "--headed=") {
				panic(errors.New("--headed is not an argument here: pass headed: true, and only for a gesture that has to be physical"))
			}
			args = append(args, value)
		}
	}
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
		return agentToolsText(envelope)
	}
	if ok, _ := record["ok"].(bool); !ok {
		return agentToolsText(envelope)
	}
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

type desktopExecutionContext struct {
	Sandboxed bool
	AccessMode string
	Role string
	PolicyDigest string
}

func desktopExecutionContextOf(input AgentToolsInput) desktopExecutionContext {
	context := desktopExecutionContext{Sandboxed: true, AccessMode: "unknown", Role: input.Role}
	if input.Access == nil {
		return context
	}
	context.AccessMode = string(input.Access.Mode)
	context.PolicyDigest = input.Access.Digest
	context.Sandboxed = false
	return context
}

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

func agentToolsDesktopWantsOutput(params map[string]any) bool {
	return strings.EqualFold(strings.TrimSpace(agentToolsStringOrEmpty(params["include"])), "output")
}

func desktopCapabilityRoot(catalog *Catalog) string {
	if catalog == nil {
		return ""
	}
	return catalog.CapabilityRootPath()
}
