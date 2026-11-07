package graph

import (
	"os"
	"path/filepath"
	"strings"
)

type gitWorktree struct {
	Path   string
	Branch string
}

func WorktreeList(repo string) []gitWorktree {
	result := Git(repo, []string{"worktree", "list", "--porcelain"}, nil, nil)
	trees := []gitWorktree{}
	var current *gitWorktree
	for _, line := range strings.Split(result.Stdout, "\n") {
		if strings.HasPrefix(line, "worktree ") {
			if current != nil {
				trees = append(trees, *current)
			}
			current = &gitWorktree{Path: filepath.Clean(line[9:])}
		} else if strings.HasPrefix(line, "branch ") && current != nil {
			current.Branch = strings.TrimPrefix(line[7:], "refs/heads/")
		}
	}
	if current != nil {
		trees = append(trees, *current)
	}
	return trees
}

func EnsureBranch(repo, name, startPoint string) {
	if RevParse(repo, name) != nil {
		return
	}
	created := Git(repo, []string{"branch", "--", name, startPoint}, nil, nil)
	if created.Code != 0 {
		text := created.Stderr
		if text == "" {
			text = "Failed to create branch " + name
		}
		panic(gitError(text))
	}
}

func EnsureWorktree(repo, path, branch, startPoint string) {
	resolved := filepath.Clean(path)
	for _, tree := range WorktreeList(repo) {
		if tree.Path == resolved {
			EnsureHostExcludes(resolved, nil)
			return
		}
	}
	if _, err := os.Stat(resolved); err == nil {
		panic(gitError("Worktree path already exists: " + resolved))
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		panic(err)
	}
	EnsureBranch(repo, branch, startPoint)
	added := Git(repo, []string{"worktree", "add", resolved, branch}, nil, nil)
	if added.Code != 0 {
		text := added.Stderr
		if text == "" {
			text = "Failed to add worktree " + resolved
		}
		panic(gitError(text))
	}
	EnsureHostExcludes(resolved, nil)
}

func CommitAll(cwd, message string, identity *GitIdentity) *string {
	Git(cwd, []string{"add", "-A"}, nil, identity)
	if IsClean(cwd, nil) {
		return RevParse(cwd, "HEAD")
	}
	committed := Git(cwd, []string{"commit", "--no-verify", "-m", message}, nil, identity)
	if committed.Code != 0 {
		text := committed.Stderr
		if text == "" {
			text = "Commit failed"
		}
		panic(gitError(text))
	}
	return RevParse(cwd, "HEAD")
}
