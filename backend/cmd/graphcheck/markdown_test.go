package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func writeMarkdownBaseline(t *testing.T, root string) {
	t.Helper()
	dir := filepath.Join(root, "backend", "internal", "gate", "testdata")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	payload := []byte(`{"allowed":["AGENTS.md"]}`)
	if err := os.WriteFile(filepath.Join(dir, "prose-baseline.json"), payload, 0o644); err != nil {
		t.Fatalf("write baseline: %v", err)
	}
}

func TestProseRecordCannotAddNewProse(t *testing.T) {
	root := t.TempDir()
	baselineDir := filepath.Join(root, "backend", "internal", "gate", "testdata")
	if err := os.MkdirAll(baselineDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baselineDir, "prose-baseline.json"), []byte(`{"allowed":["kept.md"]}`), 0o644); err != nil {
		t.Fatalf("write baseline: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "kept.md"), []byte("# still converting\n"), 0o644); err != nil {
		t.Fatalf("write kept: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "brand-new.md"), []byte("# a new document\n"), 0o644); err != nil {
		t.Fatalf("write new: %v", err)
	}
	status := 0
	output := captureStderr(t, func() { status = runProse(root, []string{"--record"}) })
	if status == 0 {
		t.Fatal("recording must not be able to bless a new markdown file")
	}
	for _, want := range []string{"brand-new.md", "cannot add", "graph:allow-prose:"} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
	payload, err := os.ReadFile(filepath.Join(baselineDir, "prose-baseline.json"))
	if err != nil {
		t.Fatalf("read baseline: %v", err)
	}
	if strings.Contains(string(payload), "brand-new.md") {
		t.Fatalf("the baseline was rewritten with the new file: %s", payload)
	}
}

func TestProseRecordCanShrink(t *testing.T) {
	root := t.TempDir()
	baselineDir := filepath.Join(root, "backend", "internal", "gate", "testdata")
	if err := os.MkdirAll(baselineDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baselineDir, "prose-baseline.json"), []byte(`{"allowed":["kept.md","converted.md"]}`), 0o644); err != nil {
		t.Fatalf("write baseline: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "kept.md"), []byte("# still converting\n"), 0o644); err != nil {
		t.Fatalf("write kept: %v", err)
	}
	if status := runProse(root, []string{"--record"}); status != 0 {
		t.Fatalf("recording a shrink must succeed, got %d", status)
	}
	payload, err := os.ReadFile(filepath.Join(baselineDir, "prose-baseline.json"))
	if err != nil {
		t.Fatalf("read baseline: %v", err)
	}
	if strings.Contains(string(payload), "converted.md") {
		t.Fatalf("a converted file must leave the baseline: %s", payload)
	}
	if !strings.Contains(string(payload), "kept.md") {
		t.Fatalf("a file still in the tree must stay listed: %s", payload)
	}
}

func TestProseStagedRejectsANewMarkdownFile(t *testing.T) {
	root := t.TempDir()
	run := func(args ...string) {
		command := exec.Command("git", args...)
		command.Dir = root
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}
	run("init", "-q")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("# agents\n"), 0o644); err != nil {
		t.Fatalf("write agents: %v", err)
	}
	run("add", "AGENTS.md")
	run("commit", "-q", "-m", "base")
	writeMarkdownBaseline(t, root)
	if err := os.WriteFile(filepath.Join(root, "handbook.md"), []byte("# a new doc\n"), 0o644); err != nil {
		t.Fatalf("write handbook: %v", err)
	}
	status := 0
	output := captureStderr(t, func() { status = runProse(root, []string{"--staged"}) })
	if status == 0 {
		t.Fatal("an untracked new markdown file in the change must be rejected")
	}
	if !strings.Contains(output, "handbook.md") {
		t.Errorf("failure output does not name the file:\n%s", output)
	}
}

func TestProseStagedAcceptsAnEditToAnExistingFile(t *testing.T) {
	root := t.TempDir()
	run := func(args ...string) {
		command := exec.Command("git", args...)
		command.Dir = root
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}
	run("init", "-q")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("# agents\n"), 0o644); err != nil {
		t.Fatalf("write agents: %v", err)
	}
	baselineDir := filepath.Join(root, "backend", "internal", "gate", "testdata")
	if err := os.MkdirAll(baselineDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baselineDir, "prose-baseline.json"), []byte(`{"allowed":["AGENTS.md"]}`), 0o644); err != nil {
		t.Fatalf("write baseline: %v", err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "base")
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("# agents, edited\n"), 0o644); err != nil {
		t.Fatalf("edit agents: %v", err)
	}
	if status := runProse(root, []string{"--staged"}); status != 0 {
		t.Fatalf("editing an existing document must stay possible, got %d", status)
	}
}

func TestProseStagedHonoursAReasonedExemption(t *testing.T) {
	root := t.TempDir()
	run := func(args ...string) {
		command := exec.Command("git", args...)
		command.Dir = root
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}
	run("init", "-q")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("# agents\n"), 0o644); err != nil {
		t.Fatalf("write agents: %v", err)
	}
	run("add", "AGENTS.md")
	run("commit", "-q", "-m", "base")
	writeMarkdownBaseline(t, root)
	if err := os.WriteFile(filepath.Join(root, "manual.md"), []byte("<!-- graph:allow-prose: the user asked for this one -->\n# manual\n"), 0o644); err != nil {
		t.Fatalf("write manual: %v", err)
	}
	if status := runProse(root, []string{"--staged"}); status != 0 {
		t.Fatalf("a file exempted in place must pass the staged check, got %d", status)
	}
	if err := os.WriteFile(filepath.Join(root, "manual.md"), []byte("<!-- graph:allow-prose: -->\n# manual\n"), 0o644); err != nil {
		t.Fatalf("rewrite manual: %v", err)
	}
	if status := runProse(root, []string{"--staged"}); status == 0 {
		t.Fatal("an exemption with no reason must not pass")
	}
}
