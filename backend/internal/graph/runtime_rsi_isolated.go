package graph

import (
	"os"
	"path/filepath"
)

func rsiIsolatedWorktree(root string, owned []string) (string, bool, func()) {
	head := RevParse(root, "HEAD")
	if head == nil {
		return root, false, func() {}
	}
	snapshot, cleanup := rsiSnapshotRoot(root, *head)
	if snapshot == root {
		return root, false, func() {}
	}
	seen := map[string]bool{}
	for _, path := range owned {
		if seen[path] {
			continue
		}
		seen[path] = true
		rsiCopyBetweenRoots(root, snapshot, path)
	}
	return snapshot, true, cleanup
}

func rsiLandIsolatedCommit(root, work, commit string, paths []string) {
	moved := Git(root, []string{"reset", "-q", "--mixed", commit}, nil, nil)
	if moved.Code != 0 {
		Raise("rsi_git", rsiFirstText(moved.Stderr, "Failed to move the branch onto the verified commit"))
	}
	if head := RevParse(root, "HEAD"); head == nil || *head != commit {
		Raise("rsi_git", "The verified commit did not land on the checked out branch")
	}
	rsiCopyPaths(work, root, paths)
}

func rsiCopyPaths(source, target string, paths []string) {
	seen := map[string]bool{}
	for _, path := range paths {
		if seen[path] {
			continue
		}
		seen[path] = true
		rsiCopyBetweenRoots(source, target, path)
	}
}

func rsiCopyBetweenRoots(source, target, path string) {
	from := filepath.Join(source, path)
	to := filepath.Join(target, path)
	content, err := os.ReadFile(from)
	if err != nil {
		if !os.IsNotExist(err) {
			panic(err)
		}
		_ = os.Remove(to)
		return
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
		panic(err)
	}
	if err := os.WriteFile(to, content, 0o644); err != nil {
		panic(err)
	}
}
