package graph

import (
	"errors"
	"path/filepath"
	"strings"

	"os"
)

const RUNTIME_NODE_ENV = "GRAPH_APP_NODE"

type CommandResult struct {
	Code   *int   `json:"code"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

type ResolvedCommand struct {
	Executable string
	Args       []string
	ReadPaths  []string
	Env        map[string]string
}

func GraphNodeRuntime(env map[string]string) (execPath string, electron string) {
	if env == nil {
		env = environMap()
	}
	if bundled := existingNode(strings.TrimSpace(env[RUNTIME_NODE_ENV])); bundled != "" {
		return bundled, ""
	}
	if found := lookupNodeOnPath(env); found != "" {
		return found, ""
	}
	return "", ""
}

func MissingNodeRuntime(purpose string) error {
	return errors.New("No Node.js runtime is available to " + purpose +
		"; install node, or point " + RUNTIME_NODE_ENV + " at one")
}

func existingNode(path string) string {
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Mode().Perm()&0o111 == 0 {
		return ""
	}
	return path
}

func lookupNodeOnPath(env map[string]string) string {
	path := env["PATH"]
	if path == "" {
		path = os.Getenv("PATH")
	}
	if path == "" {
		return ""
	}
	for _, directory := range strings.Split(path, ":") {
		if directory == "" {
			continue
		}
		candidate := filepath.Join(directory, "node")
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
			return candidate
		}
	}
	return ""
}

func resolverShim() string {
	return runtimeScript("check-resolver.cjs")
}

func gitExecutable() string {
	candidates := []string{"/Library/Developer/CommandLineTools/usr/bin/git", "/usr/bin/git"}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "/usr/bin/git"
}

func ResolveNodeCommand(args []string, execPath, electron string, shim bool) ResolvedCommand {
	if execPath == "" {
		execPath, electron = GraphNodeRuntime(nil)
	}
	prefix := []string{}
	if shim && !containsString(args, "--check") {
		prefix = []string{"--require", resolverShim()}
	}
	shimArgs := append(append([]string{}, prefix...), args...)
	if electron == "" {
		command := ResolvedCommand{Executable: execPath, Args: shimArgs}
		if len(prefix) > 0 {
			command.ReadPaths = []string{filepath.Dir(resolverShim())}
		}
		return command
	}
	reads := []string{filepath.Dir(filepath.Dir(execPath))}
	if len(prefix) > 0 {
		reads = append([]string{filepath.Dir(resolverShim())}, reads...)
	}
	return ResolvedCommand{Executable: execPath, Args: shimArgs, ReadPaths: reads, Env: map[string]string{"ELECTRON_RUN_AS_NODE": "1"}}
}
func pathCommand(command string, args []string) ResolvedCommand {
	candidates := []string{}
	if strings.Contains(command, "/") {
		candidates = []string{command}
	} else {
		for _, directory := range strings.Split(os.Getenv("PATH"), ":") {
			if directory == "" {
				continue
			}
			candidates = append(candidates, filepath.Join(directory, command))
		}
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		if info.Mode()&0o111 != 0 {
			return ResolvedCommand{Executable: candidate, Args: args}
		}
	}
	Raise("permission", "Command "+command+" was not found on PATH")
	return ResolvedCommand{}
}

func resolveHostCommand(command string, args []string) ResolvedCommand {
	if command == "node" {
		return ResolveNodeCommand(args, "", "", true)
	}
	return pathCommand(command, args)
}

func ResolveUnsandboxedCommand(command string, args []string) ResolvedCommand {
	if command == "node" {
		return ResolveNodeCommand(args, "", "", false)
	}
	return pipefailShell(pathCommand(command, args))
}

func pipefailShell(command ResolvedCommand) ResolvedCommand {
	base := filepath.Base(command.Executable)
	if base != "sh" && base != "bash" {
		return command
	}
	for _, arg := range command.Args {
		if arg != "-c" {
			continue
		}
		args := append([]string{"-o", "pipefail"}, command.Args...)
		return ResolvedCommand{Executable: "/bin/bash", Args: args, Env: command.Env}
	}
	return command
}

type WorkspaceCommandRunner struct {
	workspace  string
	scratchDir string
	gate       SendGate
	env        map[string]string
	timeoutMs  int
	acquired   *restrictedLease
	closed     bool
}

func OpenWorkspaceCommandRunner(workspace, scratchDir string, gate SendGate, env map[string]string, timeoutMs int) *WorkspaceCommandRunner {
	resolved, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		panic(err)
	}
	if timeoutMs <= 0 {
		timeoutMs = 120_000
	}
	return &WorkspaceCommandRunner{
		workspace: resolved, scratchDir: scratchDir, gate: gate, env: env, timeoutMs: timeoutMs,
	}
}

func (runner *WorkspaceCommandRunner) Run(command string, args []string, signal *AbortSignal) CommandResult {
	return runner.run(command, args, signal, 0)
}

func (runner *WorkspaceCommandRunner) RunWithTimeout(command string, args []string, signal *AbortSignal, timeoutMs int) CommandResult {
	return runner.run(command, args, signal, timeoutMs)
}

func (runner *WorkspaceCommandRunner) run(command string, args []string, signal *AbortSignal, timeoutMs int) CommandResult {
	resolved := resolveHostCommand(command, args)
	if runner.acquired == nil {
		lease := AcquireRestrictedExecutor()
		runner.acquired = &restrictedLease{Executor: lease.Executor, Release: lease.Release}
	}
	if err := os.MkdirAll(runner.scratchDir, 0o700); err != nil {
		panic(err)
	}
	scratch, err := filepath.EvalSymlinks(runner.scratchDir)
	if err != nil {
		panic(err)
	}
	environment := map[string]string{"PATH": os.Getenv("PATH")}
	for key, value := range runner.env {
		environment[key] = value
	}
	for key, value := range resolved.Env {
		environment[key] = value
	}
	limit := runner.timeoutMs
	if timeoutMs > 0 {
		limit = timeoutMs
	}
	cmd := RestrictedCommand{
		Broker: runner.gate, Cwd: runner.workspace, ScratchDir: scratch,
		Executable: resolved.Executable, Args: resolved.Args,
		TimeoutMs: limit,
		Signal:    signal,
	}
	if len(environment) > 0 {
		cmd.Env = environment
	}
	return runner.acquired.Executor.Run(cmd)
}

func (runner *WorkspaceCommandRunner) Close() {
	if runner.closed {
		return
	}
	runner.closed = true
	if runner.acquired != nil && runner.acquired.Release != nil {
		runner.acquired.Release()
	}
}
