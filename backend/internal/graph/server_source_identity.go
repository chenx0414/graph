package graph

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// SourceIdentity is which code the running daemon is actually executing.
// It is read once, at startup.
type SourceIdentity struct {
	Root   string  `json:"root"`
	Commit *string `json:"commit"`
	Branch *string `json:"branch"`
	Dirty  *bool   `json:"dirty"`
}

func sourceIdentityRun(root string, args ...string) (ok bool, out string) {
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	cmd.Stdin = nil
	cmd.Stderr = nil
	output, err := cmd.Output()
	if err != nil {
		return false, ""
	}
	return true, strings.TrimSpace(string(output))
}

// ReadSourceIdentity reads the running source identity.
// A root without package.json, or a git failure, leaves commit, branch and dirty unknown.
func ReadSourceIdentity(root string) SourceIdentity {
	if _, err := os.Stat(filepath.Join(root, "package.json")); err != nil {
		return SourceIdentity{Root: root}
	}
	commitOK, commitOut := sourceIdentityRun(root, "rev-parse", "HEAD")
	branchOK, branchOut := sourceIdentityRun(root, "rev-parse", "--abbrev-ref", "HEAD")
	statusOK, statusOut := sourceIdentityRun(root, "status", "--porcelain")
	identity := SourceIdentity{Root: root}
	if commitOK && commitOut != "" {
		identity.Commit = &commitOut
	}
	if branchOK && branchOut != "" && branchOut != "HEAD" {
		identity.Branch = &branchOut
	}
	if statusOK {
		dirty := len(statusOut) > 0
		identity.Dirty = &dirty
	}
	return identity
}
