package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type ProjectPathEntry struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type projectPathOptions struct {
	StateDir string
	Query    string
	Limit    int
}

func ProjectPathEntries(root string, options projectPathOptions) []ProjectPathEntry {
	projectRoot := gitReal(root)
	repo := DetectRepo(projectRoot)
	files := map[string]bool{}
	directories := map[string]bool{}
	fileOrder := []string{}
	dirOrder := []string{}
	addFile := func(path string) {
		normalized := strings.TrimPrefix(strings.ReplaceAll(path, "\\", "/"), "./")
		if normalized == "" || files[normalized] {
			return
		}
		files[normalized] = true
		fileOrder = append(fileOrder, normalized)
		parts := strings.Split(normalized, "/")
		for index := 1; index < len(parts); index++ {
			dir := strings.Join(parts[:index], "/")
			if !directories[dir] {
				directories[dir] = true
				dirOrder = append(dirOrder, dir)
			}
		}
	}
	if repo != nil {
		scope := strings.ReplaceAll(filepath.ToSlash(relPath(*repo, projectRoot)), "\\", "/")
		if scope == "." {
			scope = ""
		}
		prefix := ""
		if scope != "" {
			prefix = scope + "/"
		}
		var stateRel *string
		if options.StateDir != "" && PathInside(*repo, options.StateDir) {
			value := strings.ReplaceAll(filepath.ToSlash(relPath(*repo, gitReal(options.StateDir))), "\\", "/")
			stateRel = &value
		}
		scopeArg := scope
		if scopeArg == "" {
			scopeArg = "."
		}
		raw := GitRaw(*repo, []string{"ls-files", "-co", "--exclude-standard", "-z", "--", scopeArg}, nil, nil).Stdout
		for _, item := range strings.Split(raw, "\x00") {
			repoPath := strings.ReplaceAll(item, "\\", "/")
			checkScope := scope
			if checkScope == "" {
				checkScope = "."
			}
			if repoPath == "" || !gitInScope(repoPath, checkScope) || BaselineExcluded(repoPath, stateRel) {
				continue
			}
			shown := repoPath
			if prefix != "" && strings.HasPrefix(repoPath, prefix) {
				shown = repoPath[len(prefix):]
			}
			addFile(shown)
		}
	} else {
		var stateRel *string
		if options.StateDir != "" && PathInside(projectRoot, options.StateDir) {
			value := strings.ReplaceAll(filepath.ToSlash(relPath(projectRoot, gitReal(options.StateDir))), "\\", "/")
			stateRel = &value
		}
		count := 0
		var walk func(dir, base string)
		walk = func(dir, base string) {
			if count > 5000 {
				return
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				return
			}
			sort.Slice(entries, func(i, j int) bool { return lessByByteOrder(entries[i].Name(), entries[j].Name()) })
			for _, entry := range entries {
				path := entry.Name()
				if base != "" {
					path = base + "/" + entry.Name()
				}
				if BaselineExcluded(path, stateRel) {
					continue
				}
				if entry.IsDir() {
					if !directories[path] {
						directories[path] = true
						dirOrder = append(dirOrder, path)
					}
					walk(filepath.Join(dir, entry.Name()), path)
					continue
				}
				info, err := entry.Info()
				if err != nil || !info.Mode().IsRegular() {
					continue
				}
				count++
				addFile(path)
			}
		}
		walk(projectRoot, "")
	}
	query := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(options.Query), "\\", "/"))
	entries := []ProjectPathEntry{}
	for _, path := range dirOrder {
		entries = append(entries, ProjectPathEntry{Path: path, Kind: "directory"})
	}
	for _, path := range fileOrder {
		entries = append(entries, ProjectPathEntry{Path: path, Kind: "file"})
	}
	filtered := []ProjectPathEntry{}
	for _, entry := range entries {
		if query == "" || strings.Contains(strings.ToLower(entry.Path), query) {
			filtered = append(filtered, entry)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		score := func(entry ProjectPathEntry) int {
			if query == "" {
				return 0
			}
			lower := strings.ToLower(entry.Path)
			base := lower
			if slash := strings.LastIndex(lower, "/"); slash >= 0 {
				base = lower[slash+1:]
			}
			if strings.HasPrefix(lower, query) {
				return 0
			}
			if strings.HasPrefix(base, query) {
				return 1
			}
			return 2
		}
		left, right := score(filtered[i]), score(filtered[j])
		if left != right {
			return left < right
		}
		if len(filtered[i].Path) != len(filtered[j].Path) {
			return len(filtered[i].Path) < len(filtered[j].Path)
		}
		return filtered[i].Path < filtered[j].Path
	})
	limit := options.Limit
	if limit == 0 {
		limit = 80
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	if len(filtered) > limit {
		filtered = filtered[:limit]
	}
	return filtered
}
