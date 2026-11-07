package graph

import (
	"os"
	"path/filepath"
	"strings"
)

func GitPaths(repo string) gitPathPair {
	dir := Git(repo, []string{"rev-parse", "--absolute-git-dir"}, nil, nil).Stdout
	common := Git(repo, []string{"rev-parse", "--path-format=absolute", "--git-common-dir"}, nil, nil).Stdout
	var gitDir, commonDir *string
	if dir != "" {
		gitDir = &dir
	}
	chosen := common
	if chosen == "" {
		chosen = dir
	}
	if chosen != "" {
		commonDir = &chosen
	}
	return gitPathPair{GitDir: gitDir, CommonDir: commonDir}
}

func EnsureHostExcludes(repo string, extra []string) {
	paths := GitPaths(repo)
	base := ""
	if paths.CommonDir != nil {
		base = *paths.CommonDir
	} else if paths.GitDir != nil {
		base = *paths.GitDir
	}
	if base == "" {
		return
	}
	dir := filepath.Join(base, "info")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	file := filepath.Join(dir, "exclude")
	existingBytes, err := os.ReadFile(file)
	existing := ""
	if err == nil {
		existing = string(existingBytes)
	}
	lines := map[string]bool{}
	for _, line := range strings.Split(existing, "\n") {
		lines[line] = true
	}
	missing := []string{}
	for _, line := range append(append([]string{}, HOST_EXCLUDES...), extra...) {
		if !lines[line] {
			missing = append(missing, line)
		}
	}
	if len(missing) == 0 {
		return
	}
	prefix := existing
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		prefix += "\n"
	}
	if err := os.WriteFile(file, []byte(prefix+strings.Join(missing, "\n")+"\n"), 0o644); err != nil {
		panic(err)
	}
}

var envDocWhitelist = map[string]bool{
	".env.example": true, ".env.sample": true, ".env.template": true, ".env.dist": true, ".env.defaults": true,
}

func envLike(name string) bool {
	return name == ".env" || strings.HasPrefix(name, ".env.")
}

func BaselineExcluded(relPath string, stateRel *string) bool {
	normalized := strings.ReplaceAll(relPath, "\\", "/")
	if stateRel != nil && (normalized == *stateRel || strings.HasPrefix(normalized, *stateRel+"/")) {
		return true
	}
	segments := strings.Split(normalized, "/")
	blocked := map[string]bool{"node_modules": true, "dist": true, "coverage": true, ".stage": true, ".git": true}
	for _, segment := range segments {
		if blocked[segment] {
			return true
		}
	}
	name := ""
	if len(segments) > 0 {
		name = segments[len(segments)-1]
	}
	if name == "graph.config.json" || name == "secrets.json" || name == ".DS_Store" {
		return true
	}
	if sqliteName.MatchString(name) {
		return true
	}
	if envLike(name) && !envDocWhitelist[name] {
		return true
	}
	if secretName.MatchString(name) || name == ".netrc" || name == ".git-credentials" {
		return true
	}
	return false
}
