package gate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A worktree holds another checkout of this repository. Its uncommitted files are
// that checkout's work, not new markdown in this one, so the prose gate must not
// count them against this tree.
func TestStagedMarkdownIgnoresWorktrees(t *testing.T) {
	root := t.TempDir()
	command := exec.Command("git", "init", "-q")
	command.Dir = root
	if err := command.Run(); err != nil {
		t.Fatalf("git init: %v", err)
	}
	nested := filepath.Join(root, ".worktrees", "branch", "verification")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "task.md"), []byte("# task\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := StagedMarkdown(root)
	if err != nil {
		t.Fatalf("staged: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Path, ".worktrees/") {
			t.Fatalf("a worktree's markdown is that checkout's work, got %v", entries)
		}
	}
}

// ScanProse walks the repository. A worktree under .worktrees is another checkout
// of it, so its documents must not be counted (or converted) twice.
func TestScanProseIgnoresWorktrees(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, ".worktrees", "branch", ".agents", "skills")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "SKILL.md"), []byte("# skill\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "notes.md"), []byte("# notes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	found, err := ScanProse(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	for _, path := range found {
		if strings.HasPrefix(filepath.ToSlash(path), ".worktrees/") {
			t.Fatalf("a worktree's documents are that checkout's, got %v", found)
		}
	}
	if len(found) != 1 {
		t.Fatalf("the scan must still find this tree's document, got %v", found)
	}
}
