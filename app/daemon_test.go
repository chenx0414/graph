package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDaemonEnvironmentCarriesTheStoredSecrets(t *testing.T) {
	stateDir := t.TempDir()
	value := "sk-live"
	if err := saveSecret(secretsPath(stateDir), "GRAPH_OPENAI_KEY", &value); err != nil {
		t.Fatal(err)
	}
	env := newDaemon(Paths{StateDir: stateDir}).environment()
	if !envHas(env, "GRAPH_OPENAI_KEY", "sk-live") {
		t.Fatal("the daemon would start without the stored key")
	}
	empty := newDaemon(Paths{StateDir: t.TempDir()}).environment()
	if envHas(empty, "GRAPH_OPENAI_KEY", "sk-live") {
		t.Fatal("a state dir without secrets must not hand out a key")
	}
}

func TestDaemonRestartRefusesADaemonItDoesNotOwn(t *testing.T) {
	applied, message := newDaemon(Paths{StateDir: t.TempDir()}).restart(false)
	if applied {
		t.Fatal("a daemon this window did not start cannot be restarted for it")
	}
	if message == "" {
		t.Fatal("the caller needs a reason to show")
	}
}

func TestDaemonRestartCanStopADaemonItAdopted(t *testing.T) {
	command := exec.Command("sleep", "30")
	if err := command.Start(); err != nil {
		t.Skip("cannot start a probe process: ", err)
	}
	pid := command.Process.Pid
	reaped := make(chan struct{})
	go func() {
		_, _ = command.Process.Wait()
		close(reaped)
	}()
	d := newDaemon(Paths{StateDir: t.TempDir()})
	d.adopt(pid)
	if !d.running() {
		t.Fatal("an adopted daemon that is alive must count as running")
	}
	d.stop()
	select {
	case <-reaped:
	case <-time.After(8 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("stop left the adopted daemon running")
	}
}

func TestRestartFollowsTheLaunchAgentThatOwnsTheDaemon(t *testing.T) {
	supervisedPid, ok := launchdChildPid()
	if !ok {
		t.Skip("this machine has no process whose parent is launchd")
	}
	dir := t.TempDir()
	writeConsoleForTest(t, dir, supervisedPid)
	if !newDaemon(Paths{StateDir: dir}).supervised() {
		t.Fatalf("pid %d is launchd's child, so the agent that owns it can restart it even though this window did not start it", supervisedPid)
	}
	writeConsoleForTest(t, dir, os.Getpid())
	if newDaemon(Paths{StateDir: dir}).supervised() {
		t.Fatal("a daemon started by this window is not launchd's, and restarting the agent would not reach it")
	}
}

func launchdChildPid() (int, bool) {
	output, err := exec.Command("ps", "-eo", "pid=,ppid=").Output()
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		parent, parentErr := strconv.Atoi(fields[1])
		if pidErr != nil || parentErr != nil || parent != 1 {
			continue
		}
		return pid, true
	}
	return 0, false
}

func writeConsoleForTest(t *testing.T, stateDir string, pid int) {
	t.Helper()
	payload := fmt.Sprintf(`{"url":"http://127.0.0.1:1","pid":%d,"mode":"execute","startedAt":1}`, pid)
	if err := os.WriteFile(filepath.Join(stateDir, "console.json"), []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
}
