package main

import (
	"path/filepath"
	"testing"
)

func TestTheResourcePageKeepsTheSecretsItConfirms(t *testing.T) {
	state := newShellState("http://127.0.0.1:1", "tok")
	state.stateDir = t.TempDir()
	state.ensureResources()
	if state.resources.secretsPath != filepath.Join(state.stateDir, "secrets.json") {
		t.Fatalf("the resource page saves where the daemon reads, path %q", state.resources.secretsPath)
	}
}
