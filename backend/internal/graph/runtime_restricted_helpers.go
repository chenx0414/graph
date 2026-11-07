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

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func quotedNodeOption(value string) string {
	if !strings.ContainsAny(value, " \t\n\r\"\\") {
		return value
	}
	escaped := strings.ReplaceAll(value, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
	return "\"" + escaped + "\""
}

func jsonString(value string) string {
	encoded, err := marshalJSON(value)
	if err != nil {
		return "\"" + value + "\""
	}
	return encoded
}

func marshalJSON(value any) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}

func environmentSlice(environment map[string]string) []string {
	entries := make([]string, 0, len(environment))
	for name, value := range environment {
		entries = append(entries, name+"="+value)
	}
	return entries
}

func commandEnv(environment map[string]string, name string) (string, bool) {
	if environment == nil {
		return "", false
	}
	value, ok := environment[name]
	return value, ok
}

func homeDirectory() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return os.Getenv("HOME")
	}
	return home
}

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

var grantGlobPattern = regexp.MustCompile(`[*?\[\]]`)

func canonicalGrantAll(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		out = append(out, canonicalGrant(path))
	}
	return out
}

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

func containsPathOrSubtree(exceptions []string, path string) bool {
	for _, exception := range exceptions {
		if exception == path || strings.HasPrefix(exception, path+"/") {
			return true
		}
	}
	return false
}
