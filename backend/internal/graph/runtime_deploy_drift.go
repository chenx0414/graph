package graph

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"os"
)

// DeployDriftReport is how the checkout the app runs from compares to the development checkout
// of the same repository.
//
// "The app runs the code I am editing" is an assumption, not a fact: the daemon loads its source from
// the RSI root, feature work lands in another checkout of the same repository, and nothing said whether
// the two still agreed. The answer is the content of the two working trees as git sees them - one `git status`
// of each worktree, read through the other checkout's index - so only tracked files are compared, and a read
// never refreshes an index.
type DeployDriftReport struct {
	// Root is the development checkout this was compared against.
	Root string `json:"root"`
	// Files are tracked by both checkouts, different content.
	Files []string `json:"files"`
	// Missing are tracked on the development line and absent here: this checkout is behind.
	Missing []string `json:"missing"`
	// Extra are tracked here and absent on the development line: the development line is behind.
	Extra []string `json:"extra"`
	// RuntimeFiles are the subset under `src/`, which is what actually changes what the app does.
	RuntimeFiles []string `json:"runtimeFiles"`
	// Note is one line a reader can act on without reading the lists.
	Note string `json:"note"`
}

// deployOriginPattern reads the origin URL out of a git config file.
var deployOriginPattern = regexp.MustCompile(`\[remote "origin"\][^[]*?\n\s*url = (.+)`)

// deployResolve is the TypeScript path.resolve: absolute, normalized.
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

// deployStatusLine is one porcelain status line.
type deployStatusLine struct {
	Deleted bool
	Path    string
}

// deployParseStatusLine reads the two-character status and the path of a porcelain line.
func deployParseStatusLine(line string) (deployStatusLine, bool) {
	if len(line) < 4 {
		return deployStatusLine{}, false
	}
	status := line[:2]
	rest := line[3:]
	// A rename is reported as `old -> new`; the new path is the one that exists now.
	path := rest
	if strings.Contains(rest, " -> ") {
		path = rest[strings.LastIndex(rest, " -> ")+4:]
	}
	return deployStatusLine{Deleted: strings.Contains(status, "D"), Path: path}, true
}

// deployComparedPaths reads the tracked paths of workTree, seen through owner's index.
//
// Reading it this way is what makes the comparison cheap and exact: git compares the content itself, so
// a stat mismatch cannot produce a false difference, and only files the owner tracks take part.
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

// OriginUrl reads the origin a checkout publishes to, from its own config.
//
// Reading the file rather than asking git matters here: this runs once per neighbouring directory, and a
// git process per candidate is too slow to do inside a status route (a parent directory can hold
// thousands of entries). The trade-off is that a remote defined through an `include` is not seen - a
// checkout whose origin is only declared there is simply not recognised as a candidate.
func OriginUrl(root string) string {
	pointer := filepath.Join(root, ".git")
	info, err := os.Stat(pointer)
	if err != nil {
		return ""
	}
	dir := pointer
	if !info.IsDir() {
		// A worktree or submodule checkout keeps a file pointing at the real git directory.
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
	// A worktree's own git directory holds per-worktree state only; the config, and therefore the
	// remote, lives in the common directory it points at.
	common := filepath.Join(dir, "commondir")
	if _, err := os.Stat(common); err == nil {
		raw, err := os.ReadFile(common)
		if err != nil {
			// The TypeScript read sits inside the same try/catch, so a file that cannot be
			// read ends the whole lookup instead of falling through to the wrong directory.
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

// SameOrigin reports whether two paths are checkouts of the same repository, going by the origin they publish to.
func SameOrigin(left, right string) bool {
	leftURL := OriginUrl(left)
	return leftURL != "" && leftURL == OriginUrl(right)
}

// DevelopmentCandidates lists the checkouts to compare root against: the configured one when it is named,
// otherwise the checkouts of the same repository sitting beside it.
//
// The sibling rule is a rule, not a guess: a development checkout of this repository is normally a
// sibling, and one that publishes elsewhere is a different project and is left alone. `root` itself is
// never a candidate - comparing a checkout with itself would always report agreement and read as proof.
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
		// Only directories that hold a checkout, and only those publishing to the same origin: a parent
		// directory can hold thousands of unrelated directories (a temp directory does), and reading one
		// config file each keeps that affordable.
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

// DeployDrift compares the deployed checkout with the development checkout.
func DeployDrift(deployedRoot, developmentRoot string) DeployDriftReport {
	hereDeleted, hereChanged, hereOK := deployComparedPaths(deployedRoot, developmentRoot)
	thereDeleted, thereChanged, thereOK := deployComparedPaths(developmentRoot, deployedRoot)
	files := map[string]bool{}
	missing := map[string]bool{}
	extra := map[string]bool{}
	// Read through this checkout's index: a file it tracks but the development line does not have is
	// this checkout's own; one the development line tracks and this checkout lack is this checkout's gap.
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
	// A path present on one side only is missing there, not different; never both.
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
