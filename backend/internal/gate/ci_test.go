package gate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCILayersReadJobsFromTheWorkflows(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".github", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ci := `name: ci
on: [push]
jobs:
  changes:
    name: detect changes
    runs-on: ubuntu-latest
  lint:
    name: lint (static gates)
    runs-on: ubuntu-latest
  build:
    runs-on: ubuntu-latest
`
	if err := os.WriteFile(filepath.Join(dir, "ci.yml"), []byte(ci), 0o644); err != nil {
		t.Fatalf("write ci: %v", err)
	}
	nightly := `name: nightly
on:
  schedule:
    - cron: "30 18 * * *"
jobs:
  full:
    name: full test
    runs-on: ubuntu-latest
`
	if err := os.WriteFile(filepath.Join(dir, "nightly.yml"), []byte(nightly), 0o644); err != nil {
		t.Fatalf("write nightly: %v", err)
	}
	layers, err := CILayers(root)
	if err != nil {
		t.Fatalf("read layers: %v", err)
	}
	if len(layers) != 2 {
		t.Fatalf("both workflows must be read, got %d", len(layers))
	}
	names := strings.Join(CIJobNames(layers), ",")
	for _, want := range []string{"changes", "lint", "build", "full"} {
		if !strings.Contains(names, want) {
			t.Errorf("job names are missing %q: %s", want, names)
		}
	}
}

func TestCILayersIgnoreMissingWorkflow(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".github", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ci.yml"), []byte("name: ci\njobs:\n  lint:\n    runs-on: ubuntu-latest\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	layers, err := CILayers(root)
	if err != nil {
		t.Fatalf("a missing nightly workflow must not be an error: %v", err)
	}
	if len(layers) != 1 {
		t.Fatalf("only the present workflow counts, got %d", len(layers))
	}
}
