package graph

import (
	"os"
	"path/filepath"
	"sync"
)

type sandboxExecutor struct {
	mutex  sync.Mutex
	closed bool
}

func newSandboxExecutor() *sandboxExecutor {
	return &sandboxExecutor{}
}

func (executor *sandboxExecutor) Close() {
	executor.mutex.Lock()
	defer executor.mutex.Unlock()
	executor.closed = true
}

func (executor *sandboxExecutor) Run(command RestrictedCommand) CommandResult {
	cwd := canonicalGrant(command.Cwd)
	scratchDir := cwd
	if command.ScratchDir != "" {
		scratchDir = canonicalGrant(command.ScratchDir)
	}
	homeDir := filepath.Join(scratchDir, ".worker-home")
	if value, ok := commandEnv(command.Env, "HOME"); ok {
		homeDir = value
	} else if value, ok := os.LookupEnv("HOME"); ok {
		homeDir = value
	}
	tempDir := filepath.Join(scratchDir, ".worker-tmp")
	if value, ok := os.LookupEnv("TMPDIR"); ok {
		tempDir = value
	} else {
		tempDir = "/tmp"
	}
	commandText := shellQuote(command.Executable)
	for _, argument := range command.Args {
		commandText += " " + shellQuote(argument)
	}
	environment := map[string]string{
		"PATH":                filepath.Dir(command.Executable) + ":/usr/bin:/bin:/usr/sbin:/sbin",
		"HOME":                homeDir,
		"TMPDIR":              tempDir,
		"LANG":                "en_US.UTF-8",
		"GIT_OPTIONAL_LOCKS":  "0",
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_ATTR_NOSYSTEM":   "1",
	}
	for name, value := range command.Env {
		environment[name] = value
	}
	invocationId := newUUID()
	result := CommandResult{}
	dispatch := func() {
		result = executor.spawnAndWait(command, "/bin/bash", []string{"-o", "pipefail", "-c", "exec " + commandText}, cwd, environment, false)
	}
	if command.Preflight != nil {
		command.Preflight()
		dispatch()
	} else {
		command.Broker.Dispatch(invocationId, 0, func() any {
			dispatch()
			return nil
		})
		command.Broker.Settle(invocationId, &TokenUsage{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0})
	}
	return result
}
