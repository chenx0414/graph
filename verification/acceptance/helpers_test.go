package acceptance

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func verificationRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "verify-graph")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no verify-graph entry point above %s", dir)
		}
		dir = parent
	}
}

func runCLI(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	root := verificationRoot(t)
	command := exec.Command(filepath.Join(root, "verify-graph"), args...)
	command.Dir = root
	command.Env = append(os.Environ(), "VERIFY_GRAPH_ACCEPTANCE=1", "NO_COLOR=1")
	var stdout, stderr strings.Builder
	command.Stdout = &stdout
	command.Stderr = &stderr
	done := make(chan error, 1)
	if err := command.Start(); err != nil {
		t.Fatalf("cannot start verify-graph %v: %v", args, err)
	}
	go func() { done <- command.Wait() }()
	select {
	case <-time.After(180 * time.Second):
		_ = command.Process.Kill()
		t.Fatalf("verify-graph %v did not finish in 180s", args)
	case err := <-done:
		if err == nil {
			return stdout.String(), stderr.String(), 0
		}
		if exit, ok := err.(*exec.ExitError); ok {
			return stdout.String(), stderr.String(), exit.ExitCode()
		}
		t.Fatalf("verify-graph %v: %v", args, err)
	}
	return "", "", 0
}

// jsonObject returns the single JSON object a command printed to stdout.
func jsonObject(t *testing.T, stdout string) map[string]any {
	t.Helper()
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		t.Fatalf("stdout is empty; the command must print one JSON envelope")
	}
	if !strings.HasPrefix(trimmed, "{") {
		t.Fatalf("stdout does not start with a JSON object: %q", firstLine(trimmed))
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("stdout is not one JSON object (%v): %q", err, firstLine(trimmed))
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		t.Fatalf("stdout holds more than one JSON value; agents parse one line")
	}
	return value
}

func firstLine(s string) string {
	if index := strings.IndexByte(s, '\n'); index >= 0 {
		return s[:index]
	}
	return s
}

var commands = []string{
	"doctor", "build", "launch", "status", "ui",
	"api", "scenario", "verify", "evidence", "cleanup",
}

func helpText(t *testing.T) (string, int) {
	t.Helper()
	stdout, stderr, code := runCLI(t, "help")
	if code == 0 && strings.TrimSpace(stdout+stderr) != "" {
		return stdout + stderr, code
	}
	stdout, stderr, second := runCLI(t, "--help")
	return stdout + stderr, second
}
