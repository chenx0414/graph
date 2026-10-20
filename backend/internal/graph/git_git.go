package graph

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var sqliteName = regexp.MustCompile(`\.sqlite(-wal|-shm)?$`)
var secretName = regexp.MustCompile(`\.(pem|key|p12|pfx)$`)

// GitIdentity is the author and committer recorded on host commits.
type GitIdentity struct {
	Name  string
	Email string
}

type gitRun struct {
	Code   int
	Stdout string
	Stderr string
}

var gitFlags = []string{
	"-c", "core.pager=cat",
	"-c", "core.editor=true",
	"-c", "sequence.editor=true",
	"-c", "commit.gpgsign=false",
	"-c", "tag.gpgsign=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "advice.detachedHead=false",
}

func gitReal(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		abs, absErr := filepath.Abs(path)
		if absErr != nil {
			return path
		}
		return abs
	}
	return resolved
}

func runGit(cwd string, args []string, input *string, identity *GitIdentity, extraEnv map[string]string) gitRun {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append(append([]string{}, gitFlags...), args...)...)
	cmd.Dir = cwd
	env := os.Environ()
	name, email := "Graph", "graph@local"
	if identity != nil {
		if identity.Name != "" {
			name = identity.Name
		}
		if identity.Email != "" {
			email = identity.Email
		}
	}
	overlay := map[string]string{
		"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email,
		"GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": email,
		"GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat", "PAGER": "cat",
		"GIT_EDITOR": "true", "EDITOR": "true",
		"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
	}
	for key, value := range extraEnv {
		overlay[key] = value
	}
	for key, value := range overlay {
		env = append(env, key+"="+value)
	}
	cmd.Env = env
	if input != nil {
		cmd.Stdin = strings.NewReader(*input)
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if _, ok := err.(*exec.ExitError); !ok {
			return gitRun{Code: 1, Stdout: "", Stderr: err.Error()}
		}
	}
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	if code < 0 {
		code = 1
	}
	return gitRun{Code: code, Stdout: stdout.String(), Stderr: strings.TrimSpace(stderr.String())}
}

// Git runs git and trims stdout.
func Git(cwd string, args []string, input *string, identity *GitIdentity) gitRun {
	result := runGit(cwd, args, input, identity, nil)
	result.Stdout = strings.TrimSpace(result.Stdout)
	return result
}

// GitRaw keeps stdout bytes, including a leading status space and a trailing newline.
func GitRaw(cwd string, args []string, input *string, extraEnv map[string]string) gitRun {
	return runGit(cwd, args, input, nil, extraEnv)
}

// HasHead reports whether HEAD resolves.
func HasHead(cwd string) bool {
	return Git(cwd, []string{"rev-parse", "--verify", "-q", "HEAD"}, nil, nil).Code == 0
}

// HeadSha is HEAD, or nil when the repository has no commit.
func HeadSha(cwd string) *string { return RevParse(cwd, "HEAD") }

var HOST_EXCLUDES = []string{
	"# Graph host-managed excludes (local only)",
	".env", ".env.*", "secrets.json", ".DS_Store",
	"node_modules", "state/", "dist/", "coverage/",
	".stage/", "graph.config.json",
	"!.env.example", "!.env.sample", "!.env.template", "!.env.dist", "!.env.defaults",
}

type gitPathPair struct {
	GitDir    *string
	CommonDir *string
}

// GitPaths locates the git dir through Git, including linked worktrees.
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

// EnsureHostExcludes appends host exclude lines that are not already present.
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

// BaselineExcluded is a sensitive or host-managed path that must not enter a baseline.
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

// ProjectPathEntry is one visible project path.
type ProjectPathEntry struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type projectPathOptions struct {
	StateDir string
	Query    string
	Limit    int
}

// ProjectPathEntries lists visible project paths for chat references.
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
			// TODO(port): localeCompare; byte order is not locale order.
			sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
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

type gitStatusRecord struct {
	Code     string
	Path     string
	OrigPath string
}

func parseStatus(raw string) []gitStatusRecord {
	fields := strings.Split(raw, "\x00")
	records := []gitStatusRecord{}
	for index := 0; index < len(fields); index++ {
		field := fields[index]
		if field == "" {
			continue
		}
		code := field
		if len(field) >= 2 {
			code = field[:2]
		}
		path := ""
		if len(field) > 3 {
			path = field[3:]
		}
		if len(code) > 0 && (code[0] == 'R' || code[0] == 'C') {
			original := ""
			if index+1 < len(fields) {
				original = fields[index+1]
			}
			index++
			records = append(records, gitStatusRecord{Code: code, Path: path, OrigPath: original})
		} else if path != "" {
			records = append(records, gitStatusRecord{Code: code, Path: path})
		}
	}
	return records
}

func gitScopeOf(subdir string) string {
	if subdir != "" {
		return subdir
	}
	return "."
}

func gitStateRel(repo, stateDir string) *string {
	if stateDir != "" && PathInside(repo, stateDir) {
		value := filepath.ToSlash(relPath(repo, gitReal(stateDir)))
		return &value
	}
	return nil
}

func gitInScope(path, scope string) bool {
	return scope == "." || path == scope || strings.HasPrefix(path, scope+"/")
}

func scopedStatus(repo, subdir, stateDir string) []gitStatusRecord {
	scope := gitScopeOf(subdir)
	stateRel := gitStateRel(repo, stateDir)
	raw := GitRaw(repo, []string{"status", "--porcelain=v1", "-z", "-uall", "--", scope}, nil, nil).Stdout
	out := []gitStatusRecord{}
	for _, record := range parseStatus(raw) {
		if !gitInScope(record.Path, scope) || BaselineExcluded(record.Path, stateRel) {
			continue
		}
		if record.OrigPath != "" && !gitInScope(record.OrigPath, scope) {
			continue
		}
		out = append(out, record)
	}
	return out
}

// BaselineFiles is the explicit candidate list for a scoped baseline.
func BaselineFiles(repo, subdir, stateDir string) []string {
	paths := map[string]bool{}
	order := []string{}
	add := func(path string) {
		if path == "" || paths[path] {
			return
		}
		paths[path] = true
		order = append(order, path)
	}
	for _, record := range scopedStatus(repo, subdir, stateDir) {
		add(record.Path)
		add(record.OrigPath)
	}
	sort.Strings(order)
	return order
}

// ScopedDirty lists dirty entries a scoped baseline cannot capture.
func ScopedDirty(repo, subdir, stateDir string) []string {
	out := []string{}
	for _, record := range scopedStatus(repo, subdir, stateDir) {
		line := record.Code + " " + record.Path
		if record.OrigPath != "" {
			line += " <- " + record.OrigPath
		}
		out = append(out, line)
	}
	return out
}

// RepoFingerprint is the readiness fingerprint of a repository scope.
func RepoFingerprint(repo, subdir, stateDir string) string {
	records := scopedStatus(repo, subdir, stateDir)
	existing := []string{}
	for _, record := range records {
		if _, err := os.Stat(filepath.Join(repo, record.Path)); err == nil {
			existing = append(existing, record.Path)
		}
	}
	hashes := ""
	if len(existing) > 0 {
		joined := strings.Join(existing, "\n")
		hashes = Git(repo, []string{"hash-object", "--stdin-paths"}, &joined, nil).Stdout
	}
	parts := []string{}
	for _, record := range records {
		line := record.Code + " " + record.Path
		if record.OrigPath != "" {
			line += " " + record.OrigPath
		}
		parts = append(parts, line)
	}
	status := strings.Join(parts, "\x00")
	head := ""
	if parsed := RevParse(repo, "HEAD"); parsed != nil {
		head = *parsed
	}
	branch := ""
	if checked := CheckedOutBranch(repo); checked != nil {
		branch = *checked
	}
	sum := sha256.Sum256([]byte("head=" + head + "\nbranch=" + branch + "\nstatus=" + status + "\nblobs=" + hashes))
	return hex.EncodeToString(sum[:])
}

// DirectoryFingerprint fingerprints a directory that is not a Git repository.
func DirectoryFingerprint(root, stateDir string) string {
	stateRel := gitStateRel(root, stateDir)
	hash := sha256.New()
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
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			rel := entry.Name()
			if base != "" {
				rel = base + "/" + entry.Name()
			}
			if BaselineExcluded(rel, stateRel) {
				continue
			}
			if entry.IsDir() {
				walk(filepath.Join(dir, entry.Name()), rel)
				continue
			}
			info, err := entry.Info()
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			count++
			hash.Write([]byte(rel))
			hash.Write([]byte{0})
			body, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				hash.Write([]byte("unreadable"))
			} else {
				hash.Write(body)
			}
			hash.Write([]byte{0})
		}
	}
	walk(root, "")
	return "dir:" + itoa(count) + ":" + hex.EncodeToString(hash.Sum(nil))
}

// InitRepo creates a hermetic repository on main, then writes host excludes.
func InitRepo(root string) {
	result := Git(root, []string{"init", "--template=", "-b", "main"}, nil, nil)
	if result.Code != 0 {
		fallback := Git(root, []string{"init", "--template="}, nil, nil)
		if fallback.Code != 0 {
			message := fallback.Stderr
			if message == "" {
				message = result.Stderr
			}
			if message == "" {
				message = "git init failed"
			}
			panic(gitError(message))
		}
	}
	EnsureHostExcludes(root, nil)
}

// CommitBaseline commits exactly the given scope, never the whole index.
func CommitBaseline(cwd, message, subdir, stateDir string) string {
	var extra []string
	if stateRel := gitStateRel(cwd, stateDir); stateRel != nil {
		extra = []string{*stateRel + "/"}
	}
	EnsureHostExcludes(cwd, extra)
	head := RevParse(cwd, "HEAD")
	files := BaselineFiles(cwd, subdir, stateDir)
	if len(files) == 0 {
		if head != nil {
			return *head
		}
		empty := Git(cwd, []string{"hash-object", "-t", "tree", "/dev/null"}, nil, nil)
		created := Git(cwd, []string{"commit-tree", empty.Stdout, "-m", message}, nil, nil)
		if created.Code != 0 || created.Stdout == "" {
			text := created.Stderr
			if text == "" {
				text = "Baseline commit failed"
			}
			panic(gitError(text))
		}
		update := Git(cwd, []string{"update-ref", "HEAD", created.Stdout}, nil, nil)
		if update.Code != 0 {
			text := update.Stderr
			if text == "" {
				text = "Baseline ref update failed"
			}
			panic(gitError(text))
		}
		return created.Stdout
	}
	list := filepath.Join(filepath.Dir(filepath.Join(cwd, ".graph-tmp")), ".graph-baseline-"+itoa(os.Getpid())+"-"+itoa(int(NowMillis())))
	if err := os.WriteFile(list, []byte(strings.Join(files, "\x00")+"\x00"), 0o600); err != nil {
		panic(err)
	}
	defer os.Remove(list)
	present := []string{}
	for _, file := range files {
		if _, err := os.Stat(filepath.Join(cwd, file)); err == nil {
			present = append(present, file)
		}
	}
	if len(present) > 0 {
		added := Git(cwd, []string{"add", "-A", "--pathspec-from-file=" + list, "--pathspec-file-nul"}, nil, nil)
		if added.Code != 0 {
			fallback := Git(cwd, append([]string{"add", "--"}, present...), nil, nil)
			if fallback.Code != 0 {
				text := fallback.Stderr
				if text == "" {
					text = "Baseline add failed"
				}
				panic(gitError(text))
			}
		}
	}
	committed := Git(cwd, []string{"commit", "--no-verify", "-m", message, "--pathspec-from-file=" + list, "--pathspec-file-nul"}, nil, nil)
	if committed.Code != 0 {
		text := committed.Stderr
		if text == "" {
			text = "Baseline commit failed"
		}
		panic(gitError(text))
	}
	parsed := RevParse(cwd, "HEAD")
	if parsed == nil {
		panic(gitError("Baseline commit failed"))
	}
	return *parsed
}

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
func IsClean(cwd string, ignore []string) bool {
	prefixes := []string{}
	for _, item := range ignore {
		prefixes = append(prefixes, gitReal(item))
	}
	for _, line := range strings.Split(Git(cwd, []string{"status", "--porcelain", "-u"}, nil, nil).Stdout, "\n") {
		if line == "" {
			continue
		}
		shown := line
		if len(shown) > 3 {
			shown = shown[3:]
		}
		shown = strings.Trim(shown, "\"")
		file := gitReal(filepath.Join(cwd, shown))
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

type gitWorktree struct {
	Path   string
	Branch string
}

// WorktreeList reads porcelain worktree records.
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

// EnsureBranch creates a branch when the name does not already resolve.
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

// EnsureWorktree adds a linked worktree and states host excludes.
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

// CommitAll stages everything and commits when the tree is dirty.
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
