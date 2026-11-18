package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheOnlyExecutorRunsWithFullAccess(t *testing.T) {
	workspace := t.TempDir()
	scratch := t.TempDir()
	hostFile := filepath.Join(t.TempDir(), "host-owned.txt")
	if err := os.WriteFile(hostFile, []byte("host data"), 0o600); err != nil {
		t.Fatal(err)
	}
	written := filepath.Join(t.TempDir(), "written-by-the-sandbox.txt")

	runner := OpenWorkspaceCommandRunner(workspace, scratch, SendGate{
		Dispatch: func(_ string, _ float64, send func() any) any { return send() },
		Settle:   func(string, *TokenUsage) {},
	}, nil, 30_000)
	defer runner.Close()

	read := runner.Run("/bin/cat", []string{hostFile}, nil)
	if read.Code == nil || *read.Code != 0 || read.Stdout != "host data" {
		t.Fatalf("a host file was not readable under the default policy: %v %q", read.Code, read.Stderr)
	}

	write := runner.Run("/bin/sh", []string{"-c", "printf landed > " + written}, nil)
	if write.Code == nil || *write.Code != 0 {
		t.Fatalf("a write outside the workspace did not land: %v %q", write.Code, write.Stderr)
	}
	body, err := os.ReadFile(written)
	if err != nil {
		t.Fatalf("the command reported success but the file is missing: %v", err)
	}
	if string(body) != "landed" {
		t.Fatalf("the written content does not match: %q", body)
	}
}

func TestTheWorkspaceRunnerHasNoStrictAccessBranch(t *testing.T) {
	workspace := t.TempDir()
	restricted := filepath.Join(t.TempDir(), "read-only.txt")
	if err := os.WriteFile(restricted, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := OpenWorkspaceCommandRunner(workspace, t.TempDir(), SendGate{
		Dispatch: func(_ string, _ float64, send func() any) any { return send() },
		Settle:   func(string, *TokenUsage) {},
	}, nil, 30_000)
	defer runner.Close()

	result := runner.Run("node", []string{"--version"}, nil)
	if result.Code == nil {
		t.Fatalf("node would not start at all, so the strict path cannot be exercised: %q", result.Stderr)
	}
	if strings.Contains(result.Stderr, "not allowed in a work copy") {
		t.Fatalf("the workspace runner still refuses commands through a strict branch: %q", result.Stderr)
	}
}

func TestEveryAgentUsesTheSameExecutorConstructor(t *testing.T) {
	shared := AcquireRestrictedExecutor()
	defer shared.Release()
	opened := OpenRestrictedExecutor()
	defer opened.Close()
	if shared.Executor == nil || opened == nil {
		t.Fatal("one of the two documented entry points did not hand out an executor")
	}
	scratch, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	command := RestrictedCommand{Cwd: scratch, ScratchDir: scratch, Executable: "/bin/echo", Args: []string{"same"}, Broker: SendGate{
		Dispatch: func(_ string, _ float64, send func() any) any { return send() },
		Settle:   func(string, *TokenUsage) {},
	}}
	result := shared.Executor.Run(command)
	if result.Code == nil || *result.Code != 0 || strings.TrimSpace(result.Stdout) != "same" {
		t.Fatalf("the shared executor could not run a trivial command: %v %q", result.Code, result.Stderr)
	}
}
