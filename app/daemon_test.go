package main

import (
	"net/http/httptest"
	"os/exec"
	"path/filepath"
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

func TestBridgeReportsWhetherTheKeyReachedTheDaemon(t *testing.T) {
	stateDir := t.TempDir()
	calls := 0
	api := &shellAPI{
		secrets: secretsPath(stateDir),
		apply:   func() (bool, string) { calls++; return true, "" },
	}
	server := httptest.NewServer(api.handler("token"))
	defer server.Close()

	status, saved := call(t, server, "token", "/save-secret", `{"ref":"GRAPH_KEY","value":"sk-1"}`)
	if status != 200 || saved["stored"] != true || saved["applied"] != true {
		t.Fatalf("save answered %d %v", status, saved)
	}
	if calls != 1 {
		t.Fatalf("the apply hook ran %d times", calls)
	}
	if values := secretValues(filepath.Join(stateDir, "secrets.json")); values["GRAPH_KEY"] != "sk-1" {
		t.Fatalf("value %q", values["GRAPH_KEY"])
	}
}

func TestBridgeSaysWhyAKeyIsNotAppliedYet(t *testing.T) {
	api := &shellAPI{
		secrets: secretsPath(t.TempDir()),
		apply:   func() (bool, string) { return false, "restart Graph" },
	}
	server := httptest.NewServer(api.handler("token"))
	defer server.Close()
	_, saved := call(t, server, "token", "/save-secret", `{"ref":"GRAPH_KEY","value":"sk-1"}`)
	if saved["stored"] != true || saved["applied"] != false || saved["message"] != "restart Graph" {
		t.Fatalf("save answered %v", saved)
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
