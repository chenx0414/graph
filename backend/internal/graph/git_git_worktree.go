package graph

import (
	"path/filepath"
	"strings"
)

// DirtyEntries lists porcelain entries outside the ignored real paths.
func DirtyEntries(cwd string, ignore []string, scope string) []string {
	if scope == "" {
		scope = "."
	}
	prefixes := []string{}
	for _, item := range ignore {
		prefixes = append(prefixes, gitReal(item))
	}
	out := []string{}
	for _, record := range parseStatus(GitRaw(cwd, []string{"status", "--porcelain=v1", "-z", "-uall", "--", scope}, nil, nil).Stdout) {
		file := gitReal(filepath.Join(cwd, record.Path))
		skipped := false
		for _, prefix := range prefixes {
			if file == prefix || strings.HasPrefix(file, prefix+"/") {
				skipped = true
				break
			}
		}
		if !skipped {
			out = append(out, record.Code+" "+record.Path)
		}
	}
	return out
}

// HostExcludePaths resolves host exclude patterns against a root.
func HostExcludePaths(root string) []string {
	out := []string{}
	for _, line := range HOST_EXCLUDES {
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, "!") {
			continue
		}
		out = append(out, filepath.Clean(filepath.Join(root, strings.TrimSuffix(line, "/"))))
	}
	return out
}

// DetectRepo returns the repository top, or nil when path is not a repo.
func DetectRepo(root string) *string {
	top := Git(root, []string{"rev-parse", "--show-toplevel"}, nil, nil)
	if top.Code != 0 || top.Stdout == "" {
		return nil
	}
	resolved := filepath.Clean(top.Stdout)
	return &resolved
}

// RevParse returns the resolved ref, or nil when Git rejects it.
func RevParse(cwd, ref string) *string {
	result := Git(cwd, []string{"rev-parse", ref}, nil, nil)
	if result.Code != 0 {
		return nil
	}
	return &result.Stdout
}

// CheckedOutBranch is the branch name, or nil on a detached HEAD.
func CheckedOutBranch(repo string) *string {
	head := Git(repo, []string{"symbolic-ref", "--quiet", "HEAD"}, nil, nil)
	if head.Code != 0 {
		return nil
	}
	name := strings.TrimPrefix(head.Stdout, "refs/heads/")
	return &name
}

// IsClean is true when every porcelain line sits under an ignored prefix.
//
// The status is read with `-z` for the same reason rsiDirtyPaths does: the
// default output C-quotes a non-ASCII path, and a quoted path never matches the
// prefix it belongs to.
func IsClean(cwd string, ignore []string) bool {
	prefixes := []string{}
	for _, item := range ignore {
		prefixes = append(prefixes, gitReal(item))
	}
	for _, record := range parseStatus(GitRaw(cwd, []string{"status", "--porcelain=v1", "-z", "-u"}, nil, nil).Stdout) {
		file := gitReal(filepath.Join(cwd, record.Path))
		matched := false
		for _, prefix := range prefixes {
			if file == prefix || strings.HasPrefix(file, prefix+"/") {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

// PathInside reports whether path is root or a descendant, after realpath.
func PathInside(root, path string) bool {
	a := gitReal(root)
	b := gitReal(path)
	return b == a || strings.HasPrefix(b, a+"/")
}
