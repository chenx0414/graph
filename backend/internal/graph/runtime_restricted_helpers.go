package graph

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

// newDuplexChannel gives one child process the duplex channel its resident
// protocol uses: the child writes its notifications on it and the host answers
// on the same channel. The child end is returned so the caller can close its
// own copy once the process started: a parent that keeps the write end open
// never sees the channel reach its end.
func newDuplexChannel(process *exec.Cmd) (net.Conn, *os.File, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, nil, err
	}
	child := os.NewFile(uintptr(fds[0]), "graph-channel")
	parent := os.NewFile(uintptr(fds[1]), "graph-channel")
	process.ExtraFiles = append(process.ExtraFiles, child)
	connection, err := net.FileConn(parent)
	if err != nil {
		return nil, nil, err
	}
	parent.Close()
	return connection, child, nil
}

// newNodeIpcChannel gives one child process the Node IPC channel it expects.
// Node speaks newline-delimited JSON on that channel when the serialization
// mode says so, which is what the host answers in.
func newNodeIpcChannel(process *exec.Cmd) (net.Conn, *os.File, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, nil, err
	}
	child := os.NewFile(uintptr(fds[0]), "graph-ipc")
	parent := os.NewFile(uintptr(fds[1]), "graph-ipc")
	process.ExtraFiles = append(process.ExtraFiles, child)
	process.Env = append(process.Env, "NODE_CHANNEL_FD="+itoa(3+len(process.ExtraFiles)-1), "NODE_CHANNEL_SERIALIZATION_MODE=json")
	connection, err := net.FileConn(parent)
	if err != nil {
		return nil, nil, err
	}
	parent.Close()
	return connection, child, nil
}

// killProcessGroup signals the whole process group of a sandbox child.
func killProcessGroup(process *exec.Cmd, signal string) bool {
	if process == nil || process.Process == nil {
		return false
	}
	number, ok := sandboxSignal(signal)
	if !ok {
		return false
	}
	if err := syscall.Kill(-process.Process.Pid, number); err == nil {
		return true
	}
	return process.Process.Signal(number) == nil
}

// sandboxSignal maps a signal name to its number.
func sandboxSignal(name string) (syscall.Signal, bool) {
	switch strings.ToUpper(strings.TrimPrefix(name, "SIG")) {
	case "TERM":
		return syscall.SIGTERM, true
	case "KILL":
		return syscall.SIGKILL, true
	case "INT":
		return syscall.SIGINT, true
	case "HUP":
		return syscall.SIGHUP, true
	case "QUIT":
		return syscall.SIGQUIT, true
	}
	return 0, false
}

// sandboxSignalName is the conventional name of a signal.
func sandboxSignalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	}
	return "SIG" + itoa(int(signal))
}

// callSafely runs one host callback and reports the panic it raised.
func callSafely(run func()) (failure error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if err, ok := recovered.(error); ok {
				failure = err
				return
			}
			failure = errors.New(fmt.Sprintf("%v", recovered))
		}
	}()
	run()
	return nil
}

// shellQuote quotes one word for /bin/sh.
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// quotedNodeOption quotes one NODE_OPTIONS entry: the variable is
// whitespace-tokenized, so a generated option needs shell-style quoting.
func quotedNodeOption(value string) string {
	if !strings.ContainsAny(value, " \t\n\r\"\\") {
		return value
	}
	escaped := strings.ReplaceAll(value, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
	return "\"" + escaped + "\""
}

// jsonString encodes one string the way JSON.stringify does.
func jsonString(value string) string {
	encoded, err := marshalJSON(value)
	if err != nil {
		return "\"" + value + "\""
	}
	return encoded
}

// marshalJSON encodes one value without HTML escaping, like JSON.stringify.
func marshalJSON(value any) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}

// environmentSlice turns an environment map into the slice a process needs.
func environmentSlice(environment map[string]string) []string {
	entries := make([]string, 0, len(environment))
	for name, value := range environment {
		entries = append(entries, name+"="+value)
	}
	return entries
}

// commandEnv reads one name from an environment map.
func commandEnv(environment map[string]string, name string) (string, bool) {
	if environment == nil {
		return "", false
	}
	value, ok := environment[name]
	return value, ok
}

// homeDirectory is the host's home directory.
func homeDirectory() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return os.Getenv("HOME")
	}
	return home
}

// canonicalGrant resolves one granted path and refuses a path that is not
// already canonical.
func canonicalGrant(path string) string {
	requested, err := filepath.Abs(path)
	if err != nil {
		panic(err)
	}
	real, err := filepath.EvalSymlinks(requested)
	if err != nil {
		panic(err)
	}
	if real != requested || grantGlobPattern.MatchString(requested) {
		panic(errors.New("Expected an unchanged canonical grant path"))
	}
	return requested
}

// grantGlobPattern matches a path that spells a glob instead of a path.
var grantGlobPattern = regexp.MustCompile(`[*?\[\]]`)

// canonicalGrantAll resolves every granted path.
func canonicalGrantAll(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		out = append(out, canonicalGrant(path))
	}
	return out
}

// grantsScratch reports whether a write grant covers the scratch directory.
func grantsScratch(writePaths []string, scratchDir string) bool {
	for _, root := range writePaths {
		if scratchDir == root {
			return true
		}
		if root == "/" {
			return true
		}
		if strings.HasPrefix(scratchDir, root+"/") {
			return true
		}
	}
	return false
}

// resolveAll resolves every path against the working directory.
func resolveAll(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		resolved, err := filepath.Abs(path)
		if err != nil {
			panic(err)
		}
		out = append(out, resolved)
	}
	return out
}

// uniquePaths keeps the first spelling of every path.
func uniquePaths(paths []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, path := range paths {
		if seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

// containsPathOrSubtree reports whether an exception covers a protected path.
func containsPathOrSubtree(exceptions []string, path string) bool {
	for _, exception := range exceptions {
		if exception == path || strings.HasPrefix(exception, path+"/") {
			return true
		}
	}
	return false
}
