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

func existedWithin(t *testing.T, pidPath string, deadline time.Duration) bool {
	t.Helper()
	limit := time.Now().Add(deadline)
	for time.Now().Before(limit) {
		if _, err := os.Stat(pidPath); err == nil {
			if raw, readErr := os.ReadFile(pidPath); readErr == nil {
				return strings.TrimSpace(string(raw)) != ""
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	return false
}

func alive(pid int) bool {
	if pid <= 1 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func hostCommandEnv(t *testing.T) map[string]string {
	t.Helper()
	return map[string]string{"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": t.TempDir(), "TMPDIR": t.TempDir()}
}

func TestHostCommandReportsTheExitCodeOfTheCommand(t *testing.T) {
	outputDir := t.TempDir()
	result := RunHostCommand(HostCommandInput{
		Cwd:        t.TempDir(),
		Executable: "/bin/sh",
		Args:       []string{"-c", "printf hello; printf oops >&2; exit 3"},
		Env:        hostCommandEnv(t),
		OutputDir:  &outputDir,
	})
	if result.Code == nil || *result.Code != 3 {
		t.Fatalf("expected exit code 3, got %v (stderr %q)", result.Code, result.Stderr)
	}
	if result.Stdout != "hello" {
		t.Fatalf("stdout did not reach the caller: %q", result.Stdout)
	}
	if !strings.Contains(result.Stderr, "oops") {
		t.Fatalf("stderr did not reach the caller: %q", result.Stderr)
	}
	if len(result.OutputFiles) != 2 {
		t.Fatalf("expected preserved stdout and stderr, got %v", result.OutputFiles)
	}
}

func TestHostCommandRunsTheProcessWithoutNodeInTheMiddle(t *testing.T) {
	result := RunHostCommand(HostCommandInput{
		Cwd:        t.TempDir(),
		Executable: "/bin/sh",
		Args:       []string{"-c", "env | grep -c '^NODE_CHANNEL_FD=' || true"},
		Env:        hostCommandEnv(t),
	})
	if result.Code == nil || *result.Code != 0 {
		t.Fatalf("the probe failed: %v %q", result.Code, result.Stderr)
	}
	if strings.TrimSpace(result.Stdout) != "0" {
		t.Fatalf("the command inherited a node ipc channel, stdout %q", result.Stdout)
	}
}

func TestHostCommandKillsTheWholeProcessGroupOnExit(t *testing.T) {
	scratch := t.TempDir()
	pidPath := filepath.Join(scratch, "background.pid")
	script := "sleep 300 & echo $! > " + pidPath + "; exit 0"
	result := RunHostCommand(HostCommandInput{
		Cwd:        scratch,
		Executable: "/bin/sh",
		Args:       []string{"-c", script},
		Env:        hostCommandEnv(t),
	})
	if result.Code == nil || *result.Code != 0 {
		t.Fatalf("the command did not exit cleanly: %v %q", result.Code, result.Stderr)
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
		t.Fatalf("the background member %d survived the command; the process group was not killed", pid)
	}
}

func TestHostCommandKillsTheProcessGroupOnTimeout(t *testing.T) {
	scratch := t.TempDir()
	pidPath := filepath.Join(scratch, "timeout.pid")
	timeout := 400
	script := "sleep 300 & echo $! > " + pidPath + "; wait"
	result := RunHostCommand(HostCommandInput{
		Cwd:        scratch,
		Executable: "/bin/sh",
		Args:       []string{"-c", script},
		Env:        hostCommandEnv(t),
		TimeoutMs:  &timeout,
	})
	if !result.TimedOut {
		t.Fatalf("the timeout was not reported: %+v", result)
	}
	if result.Code != nil {
		t.Fatalf("a timed out command must not report an exit code, got %d", *result.Code)
	}
	if !strings.Contains(result.Stderr, hostCommandTimeoutMarker(timeout)) {
		t.Fatalf("the timeout marker is missing from stderr: %q", result.Stderr)
	}
	if !existedWithin(t, pidPath, 2*time.Second) {
		t.Skip("the shell could not report the background pid on this host")
	}
	raw, _ := os.ReadFile(pidPath)
	if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && alive(pid) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("the background member %d survived the timeout", pid)
	}
}

func TestHostCommandKillsTheProcessGroupOnAbort(t *testing.T) {
	scratch := t.TempDir()
	pidPath := filepath.Join(scratch, "abort.pid")
	signal := NewAbortSignal()
	aborted := make(chan struct{})
	go func() {
		if existedWithin(t, pidPath, 5*time.Second) {
			signal.Abort()
		}
		close(aborted)
	}()
	result := RunHostCommand(HostCommandInput{
		Cwd:        scratch,
		Executable: "/bin/sh",
		Args:       []string{"-c", "sleep 300 & echo $! > " + pidPath + "; wait"},
		Env:        hostCommandEnv(t),
		Signal:     signal,
	})
	<-aborted
	if result.Code != nil && *result.Code == 0 {
		t.Fatalf("an aborted command reported success: %+v", result)
	}
	raw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Skip("the shell could not report the background pid on this host")
	}
	if pid, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil && alive(pid) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("the background member %d survived the abort", pid)
	}
}

func TestHostCommandDoesNotRunWhenAdmissionRefuses(t *testing.T) {
	scratch := t.TempDir()
	marker := filepath.Join(scratch, "ran")
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("a refused admission was swallowed instead of surfacing to the caller")
		}
		if _, err := os.Stat(marker); err == nil {
			t.Fatal("the command ran even though admission refused it")
		}
	}()
	RunHostCommand(HostCommandInput{
		Cwd:        scratch,
		Executable: "/bin/sh",
		Args:       []string{"-c", "touch " + marker},
		Env:        hostCommandEnv(t),
		BeforeStart: func() {
			panic(&RuntimeError{Code: "paused", Message: "admission refused"})
		},
	})
}

func TestHostCommandWritesTheQuiescenceReceipt(t *testing.T) {
	scratch := t.TempDir()
	receipt := ProcessQuiescenceReceipt{Path: filepath.Join(scratch, "quiescence.json"), Nonce: "nonce-1"}
	result := RunHostCommand(HostCommandInput{
		Cwd:        scratch,
		Executable: "/bin/sh",
		Args:       []string{"-c", "exit 0"},
		Env:        hostCommandEnv(t),
		Quiescence: &receipt,
	})
	if result.Code == nil || *result.Code != 0 {
		t.Fatalf("the command did not exit cleanly: %v %q", result.Code, result.Stderr)
	}
	if !HasProcessQuiescence(receipt) {
		t.Fatal("the quiescence receipt was not written or did not verify")
	}
	info, err := os.Stat(receipt.Path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("the quiescence receipt is readable by other users: %v", info.Mode().Perm())
	}
}

func TestHostCommandKeepsTheQuiescenceReceiptExclusive(t *testing.T) {
	scratch := t.TempDir()
	receipt := ProcessQuiescenceReceipt{Path: filepath.Join(scratch, "quiescence.json"), Nonce: "nonce-2"}
	if err := os.WriteFile(receipt.Path, []byte(`{"nonce":"nonce-2","quiescent":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	RunHostCommand(HostCommandInput{
		Cwd:        scratch,
		Executable: "/bin/sh",
		Args:       []string{"-c", "exit 0"},
		Env:        hostCommandEnv(t),
		Quiescence: &receipt,
	})
	if !HasProcessQuiescence(receipt) {
		t.Fatal("an existing receipt was damaged by a second write")
	}
}

func TestHostCommandReturnsNilCodeWhenKilledByASignal(t *testing.T) {
	result := RunHostCommand(HostCommandInput{
		Cwd:        t.TempDir(),
		Executable: "/bin/sh",
		Args:       []string{"-c", "kill -9 $$"},
		Env:        hostCommandEnv(t),
	})
	if result.Code != nil {
		t.Fatalf("a signal-killed command must not report an exit code, got %d", *result.Code)
	}
	if !strings.Contains(result.Stderr, "SIGKILL") {
		t.Fatalf("the signal is not named in stderr: %q", result.Stderr)
	}
}
