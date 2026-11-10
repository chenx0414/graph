package main

import (
	"os/exec"
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
	applied, message := newDaemon(Paths{StateDir: t.TempDir()}).restart()
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
