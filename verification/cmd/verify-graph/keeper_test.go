package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestTheKeeperKeepsTheDaemonOffPidOne pins the reason keeper.sh exists. The
// app treats a daemon whose ppid is 1 as launchd-supervised
// (app/launchd.go:daemonSupervised) and its window refresh path stops it. The
// keeper is the live parent that makes the same daemon read as owned-by-a-shell,
// so `ui window open` adopts it instead of killing it.
func TestTheKeeperKeepsTheDaemonOffPidOne(t *testing.T) {
	dir := t.TempDir()
	keeperPath := filepath.Join(dir, "keeper.sh")
	if err := os.WriteFile(keeperPath, []byte(keeperSource), 0o755); err != nil {
		t.Fatal(err)
	}
	pidPath := filepath.Join(dir, "daemon.pid")
	command := exec.Command("/bin/sh", keeperPath, "/bin/sleep", "30")
	command.Env = append(os.Environ(), "VG_DAEMON_PIDFILE="+pidPath)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	keeperPID := command.Process.Pid
	waited := make(chan error, 1)
	go func() { waited <- command.Wait() }()
	t.Cleanup(func() {
		_ = syscall.Kill(-keeperPID, syscall.SIGKILL)
		_ = syscall.Kill(keeperPID, syscall.SIGKILL)
	})

	childPID := waitForDaemonPID(pidPath, 0, 5*time.Second)
	if childPID <= 0 || childPID == keeperPID {
		t.Fatalf("the keeper wrote no child pid (got %d, keeper %d)", childPID, keeperPID)
	}
	if ppid := ppidOf(t, childPID); ppid != keeperPID {
		t.Fatalf("the daemon's parent is %d, want keeper %d; ppid 1 would make the app stop it", ppid, keeperPID)
	}

	// Killing the daemon must let the keeper exit on its own; cleanup only ever
	// signals pids recorded in run.json (the daemon), never the shell.
	if err := syscall.Kill(childPID, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-waited:
		return
	case <-time.After(5 * time.Second):
		t.Fatalf("the keeper (pid %d) outlived its daemon", keeperPID)
	}
}

func ppidOf(t *testing.T, pid int) int {
	t.Helper()
	output, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		t.Fatalf("ps for %d: %v", pid, err)
	}
	fields := strings.Fields(string(output))
	if len(fields) == 0 {
		t.Fatalf("ps printed no ppid for %d", pid)
	}
	value, err := strconv.Atoi(fields[0])
	if err != nil {
		t.Fatalf("ppid %q: %v", fmt.Sprint(fields[0]), err)
	}
	return value
}
