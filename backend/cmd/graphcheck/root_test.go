package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRepoRootFindsBothACheckoutAndAWorktree(t *testing.T) {
	for _, tc := range []struct {
		name string
		git  func(dir string) error
	}{
		{
			name: "a checkout whose .git is a directory",
			git: func(dir string) error {
				return os.MkdirAll(filepath.Join(dir, ".git"), 0o755)
			},
		},
		{
			name: "a worktree whose .git is a file",
			git: func(dir string) error {
				return os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: /elsewhere/.git/worktrees/x\n"), 0o644)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if err := tc.git(root); err != nil {
				t.Fatalf("prepare: %v", err)
			}
			nested := filepath.Join(root, "backend", "internal")
			if err := os.MkdirAll(nested, 0o755); err != nil {
				t.Fatalf("prepare: %v", err)
			}
			previous, err := os.Getwd()
			if err != nil {
				t.Fatalf("getwd: %v", err)
			}
			if err := os.Chdir(nested); err != nil {
				t.Fatalf("chdir: %v", err)
			}
			t.Cleanup(func() { _ = os.Chdir(previous) })

			found, err := repoRoot()
			if err != nil {
				t.Fatalf("repoRoot: %v", err)
			}
			if resolved, evalErr := filepath.EvalSymlinks(found); evalErr == nil {
				found = resolved
			}
			expected := root
			if resolved, evalErr := filepath.EvalSymlinks(expected); evalErr == nil {
				expected = resolved
			}
			if found != expected {
				t.Fatalf("root from %s is %s, want %s", nested, found, expected)
			}
		})
	}
}
