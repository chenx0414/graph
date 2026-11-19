package graph

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestTheExecutorRunsOnEveryHostItIsBuiltFor(t *testing.T) {
	workspace := t.TempDir()
	runner := OpenWorkspaceCommandRunner(workspace, filepath.Join(workspace, "scratch"), SendGate{
		Dispatch: func(_ string, _ float64, send func() any) any { return send() },
		Settle:   func(string, *TokenUsage) {},
	}, nil, 30_000)
	defer runner.Close()
	result := runner.Run("/bin/sh", []string{"-c", "printf %s " + runtime.GOOS + "; exit 0"}, nil)
	if result.Code == nil {
		t.Fatalf("the executor returned no exit code on %s: %q", runtime.GOOS, result.Stderr)
	}
	if *result.Code != 0 {
		t.Fatalf("the executor failed on %s: code %d stderr %q", runtime.GOOS, *result.Code, result.Stderr)
	}
	if strings.TrimSpace(result.Stdout) != runtime.GOOS {
		t.Fatalf("the command did not report %s: %q", runtime.GOOS, result.Stdout)
	}
}

func TestTheExecutorKeepsTheProcessGroupDisciplineOnEveryHost(t *testing.T) {
	workspace := t.TempDir()
	pidPath := filepath.Join(t.TempDir(), "background.pid")
	runner := OpenWorkspaceCommandRunner(workspace, filepath.Join(workspace, "scratch"), SendGate{
		Dispatch: func(_ string, _ float64, send func() any) any { return send() },
		Settle:   func(string, *TokenUsage) {},
	}, nil, 30_000)
	defer runner.Close()
	script := "sleep 300 & echo $! > " + pidPath + "; exit 0"
	result := runner.Run("/bin/sh", []string{"-c", script}, nil)
	if result.Code == nil || *result.Code != 0 {
		t.Fatalf("the backgrounding command did not finish: %v %q", result.Code, result.Stderr)
	}
	if !existedWithin(t, pidPath, 2*time.Second) {
		t.Skip("the shell could not report the background pid on this host")
	}
	raw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if alive(pid) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("the background member %d survived the command on %s; the process group was not killed", pid, runtime.GOOS)
	}
}
