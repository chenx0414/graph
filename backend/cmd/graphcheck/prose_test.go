package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chenx0414/graph/backend/internal/gate"
)

func TestProseFailureNamesTheConversionAndTheExemption(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "notes.md"), []byte("# a rule nobody enforces\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	status := 0
	output := captureStderr(t, func() { status = runProse(root, nil) })
	if status == 0 {
		t.Fatalf("prose without a baseline must fail, got %d", status)
	}
	for _, want := range []string{"prose --record", "prose-baseline.json"} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
}

func TestProseBudgetOnlyShrinks(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "backend", "internal", "gate", "testdata"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "kept.md"), []byte("# still converting\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "backend", "internal", "gate", "testdata", "prose-baseline.json"), []byte(`{"allowed":["kept.md"]}`), 0o644); err != nil {
		t.Fatalf("write baseline: %v", err)
	}
	if code := runProse(root, nil); code != 0 {
		t.Fatalf("a baseline matching the tree must pass, got %d", code)
	}
	if err := os.WriteFile(filepath.Join(root, "fresh.md"), []byte("# new prose\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	status := 0
	output := captureStderr(t, func() { status = runProse(root, nil) })
	if status == 0 {
		t.Fatal("new prose must fail while the budget is shrinking")
	}
	for _, want := range []string{"fresh.md", "graph:allow-prose:", "graphcheck prose"} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
}

func TestProseExemptionNeedsAReason(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "exempt.md"), []byte("<!-- graph:allow-prose: converting next round -->\n# x\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "bare.md"), []byte("<!-- graph:allow-prose: -->\n# y\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	found, err := gate.ScanProse(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	joined := strings.Join(found, ",")
	if strings.Contains(joined, "exempt.md") {
		t.Errorf("an exemption with a reason must be honoured, got %v", found)
	}
	if !strings.Contains(joined, "bare.md") {
		t.Errorf("an exemption without a reason must not count, got %v", found)
	}
}

func TestDocumentationAllowanceIsNarrow(t *testing.T) {
	cases := []struct {
		path  string
		allow bool
	}{
		{"AGENTS.md", true},
		{"FEATURE_MAP.md", true},
		{".agents/skills/x/SKILL.md", true},
		{"presets/bootstrap/master/agent.md", true},
		{"docs/agent/graph-v2.md", false},
		{"CODING_STANDARDS.md", false},
		{"README.md", false},
	}
	for _, item := range cases {
		allowed, _ := gate.DocumentationAllowed(item.path)
		if allowed != item.allow {
			t.Errorf("DocumentationAllowed(%q) = %v, want %v", item.path, allowed, item.allow)
		}
	}
}
