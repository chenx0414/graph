package harness

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAStaleDaemonBinaryIsRebuiltInsteadOfReused(t *testing.T) {
	repository := t.TempDir()
	dist := filepath.Join(repository, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dist, "graphd")
	if err := os.WriteFile(binary, []byte("stale"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(binary, old, old); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(repository, "backend", "internal", "graph", "server_app_routes.go")
	if err := os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("package graph\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !daemonBinaryIsStale(repository, binary) {
		t.Fatal("a binary older than the backend sources must be reported as stale")
	}
	if err := os.Chtimes(source, old.Add(-time.Hour), old.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if daemonBinaryIsStale(repository, binary) {
		t.Fatal("a binary newer than every backend source must not be reported as stale")
	}
}
