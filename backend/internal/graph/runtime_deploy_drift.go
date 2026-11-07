package graph

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"os"
)

type DeployDriftReport struct {
	Root string `json:"root"`
	Files []string `json:"files"`
	Missing []string `json:"missing"`
	Extra []string `json:"extra"`
	RuntimeFiles []string `json:"runtimeFiles"`
	Note string `json:"note"`
}

var deployOriginPattern = regexp.MustCompile(`\[remote "origin"\][^[]*?\n\s*url = (.+)`)

func deployResolve(base, target string) string {
	if filepath.IsAbs(target) {
		return filepath.Clean(target)
	}
	joined := filepath.Join(base, target)
	absolute, err := filepath.Abs(joined)
	if err != nil {
		return joined
	}
	return absolute
}

type deployStatusLine struct {
	Deleted bool
	Path    string
}

func deployParseStatusLine(line string) (deployStatusLine, bool) {
	if len(line) < 4 {
		return deployStatusLine{}, false
	}
	status := line[:2]
	rest := line[3:]
	path := rest
	if strings.Contains(rest, " -> ") {
		path = rest[strings.LastIndex(rest, " -> ")+4:]
	}
	return deployStatusLine{Deleted: strings.Contains(status, "D"), Path: path}, true
}

func deployComparedPaths(owner, workTree string) ([]string, []string, bool) {
	result := GitRaw(owner, []string{"--work-tree", workTree, "status", "--porcelain", "--untracked-files=no"}, nil, map[string]string{"GIT_OPTIONAL_LOCKS": "0"})
	if result.Code != 0 {
		return nil, nil, false
	}
	deleted := []string{}
	changed := []string{}
	for _, line := range strings.Split(result.Stdout, "\n") {
		parsed, ok := deployParseStatusLine(line)
		if !ok {
			continue
		}
		if parsed.Deleted {
			deleted = append(deleted, parsed.Path)
		} else {
			changed = append(changed, parsed.Path)
		}
	}
	return deleted, changed, true
}

func OriginUrl(root string) string {
	pointer := filepath.Join(root, ".git")
	info, err := os.Stat(pointer)
	if err != nil {
		return ""
	}
	dir := pointer
	if !info.IsDir() {
		raw, err := os.ReadFile(pointer)
		if err != nil {
			return ""
		}
		line := strings.TrimSpace(string(raw))
		if !strings.HasPrefix(strings.ToLower(line), "gitdir:") {
			return ""
		}
		target := strings.TrimSpace(line[len("gitdir:"):])
		if filepath.IsAbs(target) {
			dir = target
		} else {
			dir = deployResolve(filepath.Dir(pointer), target)
		}
	}
	common := filepath.Join(dir, "commondir")
	if _, err := os.Stat(common); err == nil {
		raw, err := os.ReadFile(common)
		if err != nil {
			return ""
		}
		target := strings.TrimSpace(string(raw))
		if target != "" {
			if filepath.IsAbs(target) {
				dir = target
			} else {
				dir = deployResolve(dir, target)
			}
		}
	}
	config := filepath.Join(dir, "config")
	raw, err := os.ReadFile(config)
	if err != nil {
		return ""
	}
	match := deployOriginPattern.FindSubmatch(raw)
	if match == nil {
		return ""
	}
	return strings.TrimSpace(string(match[1]))
}

func SameOrigin(left, right string) bool {
	leftURL := OriginUrl(left)
	return leftURL != "" && leftURL == OriginUrl(right)
}

func DevelopmentCandidates(root string, env map[string]string) []string {
	if env == nil {
		env = environMap()
	}
	if configured := strings.TrimSpace(env["GRAPH_DEVELOPMENT_ROOT"]); configured != "" {
		return []string{deployResolve("", configured)}
	}
	self := deployResolve("", root)
	parent := filepath.Dir(self)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return []string{}
	}
	own := OriginUrl(self)
	if own == "" {
		return []string{}
	}
	found := []string{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		candidate := deployResolve(parent, entry.Name())
		if candidate == self {
			continue
		}
		if OriginUrl(candidate) != own {
			continue
		}
		found = append(found, candidate)
	}
	sort.Strings(found)
	return found
}

func DeployDrift(deployedRoot, developmentRoot string) DeployDriftReport {
	hereDeleted, hereChanged, hereOK := deployComparedPaths(deployedRoot, developmentRoot)
	thereDeleted, thereChanged, thereOK := deployComparedPaths(developmentRoot, deployedRoot)
	files := map[string]bool{}
	missing := map[string]bool{}
	extra := map[string]bool{}
	if hereOK {
		for _, path := range hereChanged {
			files[path] = true
		}
		for _, path := range hereDeleted {
			extra[path] = true
		}
	}
	if thereOK {
		for _, path := range thereChanged {
			files[path] = true
		}
		for _, path := range thereDeleted {
			missing[path] = true
		}
	}
	for path := range missing {
		delete(files, path)
		delete(extra, path)
	}
	for path := range extra {
		delete(files, path)
	}
	all := []string{}
	for path := range files {
		all = append(all, path)
	}
	for path := range missing {
		all = append(all, path)
	}
	for path := range extra {
		all = append(all, path)
	}
	runtimeFiles := []string{}
	for _, path := range all {
		if strings.HasPrefix(path, "src/") {
			runtimeFiles = append(runtimeFiles, path)
		}
	}
	sort.Strings(runtimeFiles)
	resolved := deployResolve("", developmentRoot)
	name := filepath.Base(resolved)
	if resolved == string(filepath.Separator) {
		name = ""
	}
	if name == "" {
		name = developmentRoot
	}
	sorted := append([]string{}, all...)
	sort.Strings(sorted)
	sample := strings.Join(sorted[:min(len(sorted), 3)], "、")
	note := ""
	if len(files)+len(missing)+len(extra) == 0 {
		note = "部署检出与开发线 " + name + " 内容一致"
	} else {
		note = "部署检出与开发线 " + name + " 不一致：" + itoa(len(files)) + " 个文件内容不同、" +
			itoa(len(missing)) + " 个开发线有而这里没有、" + itoa(len(extra)) + " 个这里有而开发线没有（其中 " +
			itoa(len(runtimeFiles)) + " 个在 src/）：" + sample
	}
	sortedFiles := []string{}
	for path := range files {
		sortedFiles = append(sortedFiles, path)
	}
	sort.Strings(sortedFiles)
	sortedMissing := []string{}
	for path := range missing {
		sortedMissing = append(sortedMissing, path)
	}
	sort.Strings(sortedMissing)
	sortedExtra := []string{}
	for path := range extra {
		sortedExtra = append(sortedExtra, path)
	}
	sort.Strings(sortedExtra)
	return DeployDriftReport{
		Root:         resolved,
		Files:        sortedFiles,
		Missing:      sortedMissing,
		Extra:        sortedExtra,
		RuntimeFiles: runtimeFiles,
		Note:         note,
	}
}
