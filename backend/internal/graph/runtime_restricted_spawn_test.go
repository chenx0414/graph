package graph

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A command that leaves a background member behind must still finish as soon as the command
// itself exits. It used to wait for the timer: the process group was killed only after the output
// pumps had drained, and a background member holding the inherited pipes kept them open, so every
// such command paid its whole timeout - measured at 15.004s for a command that exits immediately.
func TestACommandWithABackgroundMemberReturnsWhenTheCommandExits(t *testing.T) {
	workspace := t.TempDir()
	pidPath := filepath.Join(t.TempDir(), "background.pid")
	runner := OpenWorkspaceCommandRunner(workspace, filepath.Join(workspace, "scratch"), SendGate{
		Dispatch: func(_ string, _ float64, send func() any) any { return send() },
		Settle:   func(string, *TokenUsage) {},
	}, nil, 15_000)
	defer runner.Close()

	script := "sleep 60 & echo $! > " + pidPath + "; exit 0"
	started := time.Now()
	result := runner.Run("/bin/sh", []string{"-c", script}, nil)
	elapsed := time.Since(started)
	if result.Code == nil || *result.Code != 0 {
		t.Fatalf("the command did not finish: %v %q", result.Code, result.Stderr)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("the command took %v of its 15s budget; the group is only killed after the output pumps drain", elapsed.Round(time.Millisecond))
	}

	raw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Skip("the shell could not report the background pid on this host")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	if stillAlive(pid, 5*time.Second) {
		t.Fatalf("the background member %d survived the command", pid)
	}
}

func stillAlive(pid int, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return syscall.Kill(pid, 0) == nil
}
