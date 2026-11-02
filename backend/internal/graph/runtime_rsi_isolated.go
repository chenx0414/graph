package graph

import (
	"os"
	"path/filepath"
)

// A checkout shared by two tracks: whoever is not committing right now still
// leaves their files uncommitted, and those files must not decide whether this
// change can land - nor end up inside its commit.
//
// Measured 2026-11-02: a whole other track sat uncommitted in the shared checkout
// for an hour, and every commit of mine was refused because of it; moving their
// files aside would have raced with their own writes. The change is therefore
// built and checked in a throwaway worktree at HEAD that holds only the paths it
// declares, and it lands by moving the branch. Every foreign file keeps its bytes
// and stays uncommitted exactly as it was.

// rsiIsolatedWorktree checks out HEAD into a temporary worktree and seeds it with
// the paths this change owns, so a change can be built without reading - or
// touching - anything else that happens to be dirty in the caller's checkout.
//
// It reports false when the isolated tree cannot be made; the caller then refuses
// instead of committing from a tree the checks cannot vouch for.
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
		// Seeded from the caller's tree, so the change composes on what the Agent
		// already wrote - exactly as it does in a clean checkout.
		rsiCopyBetweenRoots(root, snapshot, path)
	}
	return snapshot, true, cleanup
}

// rsiLandIsolatedCommit puts a commit built in an isolated tree onto the branch
// the caller has checked out, and brings this change's own paths to the content
// that was checked. Nothing else in that checkout moves: the foreign files keep
// their bytes and their dirty state, which is the whole point of the isolation.
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

// rsiCopyPaths brings every named path to the state it has under source, inside
// target.
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

// rsiCopyBetweenRoots brings one path to the state it has under source, inside
// target. It is how an isolated change reaches the shared checkout: the file is
// created, replaced or removed there, and nothing else in that tree is touched.
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
