package graph

import (
	"path/filepath"
	"strings"
)

// GitMergeResult is a merge that landed or the conflicts it aborted.
type GitMergeResult struct {
	Ok        bool     `json:"ok"`
	Sha       string   `json:"sha,omitempty"`
	Conflicts []string `json:"conflicts,omitempty"`
}

// MergeRef merges a ref, aborting and listing conflicts on failure.
func MergeRef(cwd, ref string) GitMergeResult {
	merged := Git(cwd, []string{"merge", "--no-edit", "--no-verify", "--", ref}, nil, nil)
	if merged.Code == 0 {
		sha := ""
		if parsed := RevParse(cwd, "HEAD"); parsed != nil {
			sha = *parsed
		}
		return GitMergeResult{Ok: true, Sha: sha}
	}
	conflicts := MergeConflictFiles(cwd)
	Git(cwd, []string{"merge", "--abort"}, nil, nil)
	return GitMergeResult{Ok: false, Conflicts: conflicts}
}

// MergeConflictFiles lists unmerged paths. A clean tree is an empty list.
func MergeConflictFiles(cwd string) []string {
	staged := Git(cwd, []string{"diff", "--name-only", "--diff-filter=U"}, nil, nil)
	if staged.Code != 0 {
		return []string{}
	}
	out := []string{}
	for _, line := range strings.Split(staged.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// GitRefResult is an update-ref or fast-forward outcome.
type GitRefResult struct {
	Ok     bool   `json:"ok"`
	Stderr string `json:"stderr,omitempty"`
}

// UpdateRef moves a ref when the previous value still matches.
func UpdateRef(repo, ref, next, previous string) GitRefResult {
	updated := Git(repo, []string{"update-ref", ref, next, previous}, nil, nil)
	if updated.Code != 0 {
		return GitRefResult{Ok: false, Stderr: updated.Stderr}
	}
	return GitRefResult{Ok: true}
}

// FastForwardCheckout fast-forwards the checkout to sha.
func FastForwardCheckout(repo, sha string) GitRefResult {
	merged := Git(repo, []string{"merge", "--ff-only", "--no-edit", sha}, nil, nil)
	if merged.Code != 0 {
		return GitRefResult{Ok: false, Stderr: merged.Stderr}
	}
	return GitRefResult{Ok: true}
}

// AbortMerge aborts a merge only when MERGE_HEAD exists.
func AbortMerge(cwd string) {
	if Git(cwd, []string{"rev-parse", "-q", "--verify", "MERGE_HEAD"}, nil, nil).Code != 0 {
		return
	}
	Git(cwd, []string{"merge", "--abort"}, nil, nil)
}

// ResetHard resets the worktree to sha.
func ResetHard(cwd, sha string) {
	reset := Git(cwd, []string{"reset", "--hard", sha}, nil, nil)
	if reset.Code != 0 {
		text := reset.Stderr
		if text == "" {
			text = "Failed to reset " + cwd
		}
		panic(gitError(text))
	}
}

func relPath(base, target string) string {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return target
	}
	return rel
}

type gitPlainError struct{ message string }

func (e *gitPlainError) Error() string { return e.message }

func gitError(message string) error { return &gitPlainError{message} }
