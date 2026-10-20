package graph

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Pi extension sources.
//
// A Pi extension capability is an npm package, a git checkout or a local
// directory. The Pi SDK's own package manager is not linked here, so the two
// things it did for Graph are done directly: the package is installed with npm
// into the SDK's temporary install root (<agentDir>/tmp/extensions), and the
// package's own `pi.extensions` list names the entry files. The install root,
// the npm arguments and the manifest field are the SDK's own, so a package
// resolved here is the package the SDK would have resolved.

// ResolvedPiExtensionSource is one resolved extension capability source.
type ResolvedPiExtensionSource struct {
	// Extension entry files the SDK resolved, in its own order.
	Entries []string `json:"entries"`
	// Directories the loaded extension needs to read (install root plus each entry's folder).
	ReadRoots []string `json:"readRoots"`
	// The version the resolved package currently has on disk.
	Version *string `json:"version"`
}

// PiExtensionSourceInput is one source-bearing capability.
type PiExtensionSourceInput struct {
	Source   string
	Cwd      string
	AgentDir string
}

// PiExtensionSourceStatus is what a source's registry says about it.
type PiExtensionSourceStatus struct {
	// The version the resolved package currently has on disk.
	Installed *string `json:"installed"`
	// The newest version the declared source resolves to, or null when the source is not npm.
	Latest *string `json:"latest"`
	// Available is true when a newer npm version exists.
	Available bool `json:"available"`
	// InstallGaps are declared entry points missing from this source's install root. A diagnostic
	// only: a published package may declare an entry it never ships, and the root is shared by
	// every temporary npm source. Nothing is ever deleted or rebuilt because of this.
	InstallGaps []string `json:"installGaps"`
}

// PiExtensionUpdate is one source-bearing capability plus what its registry says about it.
type PiExtensionUpdate struct {
	PiExtensionSourceStatus
	Id      string  `json:"id"`
	Version string  `json:"version"`
	Source  string  `json:"source"`
	Error   *string `json:"error,omitempty"`
}

// PiExtensionUpdateResult is the outcome of an install or upgrade.
type PiExtensionUpdateResult struct {
	Updated bool    `json:"updated"`
	Version *string `json:"version"`
}

const (
	piExtensionInstallTimeout = 300 * time.Second
	piExtensionQueryTimeout   = 30 * time.Second
	piExtensionStatusCacheMs  = 60_000
	piExtensionInstallName    = "pi-extensions"
)

// RUNTIME_CONDITIONS are export conditions that name a runtime entry point; anything else is a
// publisher's own dialect.
var piExtensionRuntimeConditions = map[string]bool{
	"node": true, "import": true, "require": true, "default": true, "module": true,
}

var piExtensionDeclarationPattern = regexp.MustCompile(`\.d\.(ts|mts|cts)$`)

// extensionInstalls serializes the daemon's npm mutations by agent directory, not by package
// name, including background refresh.
var extensionInstalls = map[string]*sync.Mutex{}
var extensionInstallsMu sync.Mutex

// piExtensionStatusCache remembers one source's status for a minute.
type piExtensionStatusCacheEntry struct {
	at     int64
	status PiExtensionSourceStatus
}

var piExtensionStatusCache = map[string]piExtensionStatusCacheEntry{}
var piExtensionStatusCacheMu sync.Mutex

// withExtensionInstall serializes every npm mutation for one agent directory.
//
// Every temporary npm source shares the SDK's install root. A snapshot change can be another
// package's legitimate update, not corruption. Never remove that shared tree while resolving
// one source or refreshing catalog status. Policy, and the 2026-09-25 incident that produced it:
// docs/agent/troubleshooting.md, section 共享可变状态与安装根 (serialize by canonical path; a
// destructive action needs evidence from the affected object, never a static signal).
func withExtensionInstall[T any](agentDir string, action func() (T, error)) (T, error) {
	key := piExtensionRealpath(agentDir)
	extensionInstallsMu.Lock()
	lock := extensionInstalls[key]
	if lock == nil {
		lock = &sync.Mutex{}
		extensionInstalls[key] = lock
	}
	extensionInstallsMu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	return action()
}

// piExtensionRealpath is realpath(agentDir) with the TypeScript fallback to resolve(agentDir).
func piExtensionRealpath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return absolute
}

// ResolvePiExtensionSource resolves one Pi extension capability source exactly the way the Pi SDK
// does it: `npm:<spec>`, a git URL, or a local path. The package is installed (temporary scope,
// under `<agentDir>/tmp/extensions`) and the package's own `pi.extensions` list is read, so Graph
// neither vendors a copy nor hand-writes the entry file.
func ResolvePiExtensionSource(input PiExtensionSourceInput) (ResolvedPiExtensionSource, error) {
	return withExtensionInstall(input.AgentDir, func() (ResolvedPiExtensionSource, error) {
		return resolvePiExtensionSourceOnce(input)
	})
}

// piExtensionSource is a parsed source string.
type piExtensionSource struct {
	kind    string // "npm", "git" or "local"
	spec    string
	name    string
	version string
	repo    string
	ref     string
	host    string
	path    string
}

// parsePiExtensionSource mirrors the SDK's parseSource.
func parsePiExtensionSource(source string) piExtensionSource {
	trimmed := strings.TrimSpace(source)
	if strings.HasPrefix(trimmed, "npm:") {
		spec := strings.TrimSpace(strings.TrimPrefix(trimmed, "npm:"))
		name, version := parseNpmSpec(spec)
		return piExtensionSource{kind: "npm", spec: spec, name: name, version: version}
	}
	if git, ok := parseGitSource(trimmed); ok {
		return git
	}
	return piExtensionSource{kind: "local", path: trimmed}
}

// parseNpmSpec mirrors the SDK's parseNpmSpec: `name` or `name@version`.
func parseNpmSpec(spec string) (string, string) {
	at := strings.LastIndex(spec, "@")
	if at <= 0 {
		return spec, ""
	}
	return spec[:at], spec[at+1:]
}

// parseGitSource recognises the git URL shapes the SDK recognises.
func parseGitSource(source string) (piExtensionSource, bool) {
	if source == "" {
		return piExtensionSource{}, false
	}
	if strings.HasPrefix(source, "git+") {
		source = strings.TrimPrefix(source, "git+")
	}
	if strings.HasPrefix(source, "git@") {
		host := "github.com"
		rest := strings.TrimPrefix(source, "git@")
		if index := strings.Index(rest, ":"); index > 0 {
			host = rest[:index]
			rest = rest[index+1:]
		}
		return piExtensionSource{kind: "git", repo: "https://" + host + "/" + rest, host: host, path: rest}, true
	}
	for _, prefix := range []string{"https://", "http://", "ssh://", "git://"} {
		if !strings.HasPrefix(source, prefix) {
			continue
		}
		rest := strings.TrimPrefix(source, prefix)
		host := ""
		repo := rest
		if index := strings.Index(rest, "/"); index > 0 {
			host = rest[:index]
			repo = rest[index+1:]
		}
		if !strings.HasSuffix(repo, ".git") {
			continue
		}
		ref := ""
		if index := strings.Index(repo, "#"); index >= 0 {
			ref = repo[index+1:]
			repo = repo[:index]
		}
		return piExtensionSource{kind: "git", repo: source, host: host, path: repo, ref: ref}, true
	}
	return piExtensionSource{}, false
}

// resolvePiExtensionSourceOnce installs the source if needed and reads its extension entries.
func resolvePiExtensionSourceOnce(input PiExtensionSourceInput) (ResolvedPiExtensionSource, error) {
	parsed := parsePiExtensionSource(input.Source)
	baseDir, err := piExtensionInstallPackage(parsed, input)
	if err != nil {
		return ResolvedPiExtensionSource{}, err
	}
	entries, err := piExtensionManifestEntries(baseDir)
	if err != nil {
		return ResolvedPiExtensionSource{}, err
	}
	if len(entries) == 0 {
		Raise("capability_unavailable", "Pi extension source "+input.Source+" resolved no extension entry")
	}
	if err := EnsureRequiredPeers(entries[0]); err != nil {
		return ResolvedPiExtensionSource{}, err
	}
	readRoots := []string{baseDir}
	for _, entry := range entries {
		readRoots = append(readRoots, filepath.Dir(entry))
	}
	if root := piExtensionInstallRootFor(entries[0]); root != "" {
		readRoots = append(readRoots, root)
	}
	version, err := piExtensionPackageVersionAt(entries[0], NpmSourceName(input.Source))
	if err != nil {
		return ResolvedPiExtensionSource{}, err
	}
	return ResolvedPiExtensionSource{
		Entries:   entries,
		ReadRoots: piExtensionUnique(readRoots),
		Version:   version,
	}, nil
}

// piExtensionInstallPackage installs the source in temporary scope and returns the package root.
func piExtensionInstallPackage(parsed piExtensionSource, input PiExtensionSourceInput) (string, error) {
	switch parsed.kind {
	case "npm":
		root := piExtensionNpmInstallRoot(input.AgentDir)
		if err := piExtensionEnsureNpmProject(root); err != nil {
			return "", err
		}
		installed := filepath.Join(root, "node_modules", parsed.name)
		if _, err := os.Stat(installed); err != nil {
			if _, err := piExtensionRunNpm("install", parsed.spec, "--prefix", root, "--legacy-peer-deps"); err != nil {
				return "", err
			}
		}
		return installed, nil
	case "git":
		target := piExtensionGitInstallPath(parsed, input.AgentDir)
		if _, err := os.Stat(target); err != nil {
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return "", err
			}
			if _, err := piExtensionRunCommand("git", []string{"clone", parsed.repo, target}, "", piExtensionInstallTimeout); err != nil {
				return "", err
			}
			if parsed.ref != "" {
				if _, err := piExtensionRunCommand("git", []string{"checkout", parsed.ref}, target, piExtensionInstallTimeout); err != nil {
					return "", err
				}
			}
		}
		return target, nil
	default:
		resolved := piExtensionRealpath(parsed.path)
		if _, err := os.Stat(resolved); err != nil {
			return "", errors.New("Path does not exist: " + parsed.path)
		}
		info, err := os.Stat(resolved)
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			return filepath.Dir(resolved), nil
		}
		return resolved, nil
	}
}

// piExtensionManifestEntries reads the package's own `pi.extensions` list.
func piExtensionManifestEntries(packageRoot string) ([]string, error) {
	raw, err := os.ReadFile(filepath.Join(packageRoot, "package.json"))
	if err != nil {
		return nil, err
	}
	var manifest struct {
		Pi struct {
			Extensions []string `json:"extensions"`
		} `json:"pi"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	entries := []string{}
	for _, entry := range manifest.Pi.Extensions {
		if entry == "" {
			continue
		}
		entries = append(entries, filepath.Join(packageRoot, entry))
	}
	return entries, nil
}

// piExtensionNpmInstallRoot is the SDK's temporary npm install root:
// `<agentDir>/tmp/extensions/npm/<sha256("npm-")[:8]>`.
func piExtensionNpmInstallRoot(agentDir string) string {
	base := filepath.Join(agentDir, "tmp", "extensions")
	if err := os.MkdirAll(base, 0o700); err == nil {
		_ = os.Chmod(base, 0o700)
	}
	sum := sha256.Sum256([]byte("npm-"))
	hash := hex.EncodeToString(sum[:])[:8]
	return filepath.Join(base, "npm", hash)
}

// piExtensionGitInstallPath is the SDK's temporary git install path.
func piExtensionGitInstallPath(parsed piExtensionSource, agentDir string) string {
	base := filepath.Join(agentDir, "tmp", "extensions")
	prefix := "git-" + parsed.host
	sum := sha256.Sum256([]byte(prefix + "-" + parsed.path))
	hash := hex.EncodeToString(sum[:])[:8]
	return filepath.Join(base, prefix, hash, filepath.Base(strings.TrimSuffix(parsed.path, ".git")))
}

// piExtensionEnsureNpmProject makes the install root an npm project, like the SDK does.
func piExtensionEnsureNpmProject(root string) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	manifest := filepath.Join(root, "package.json")
	if _, err := os.Stat(manifest); err == nil {
		return nil
	}
	body, err := json.MarshalIndent(map[string]any{"name": piExtensionInstallName, "private": true}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifest, body, 0o600)
}

// piExtensionInstallRootFor is the install root npm used for a temporary source:
// `<root>/node_modules/<pkg>/…`.
func piExtensionInstallRootFor(entry string) string {
	current := filepath.Dir(entry)
	for {
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		if filepath.Base(current) == "node_modules" {
			return parent
		}
		current = parent
	}
}

// piExtensionUnique keeps the first occurrence of every path.
func piExtensionUnique(paths []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, path := range paths {
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

// piExtensionPackageManifestAt is the nearest package.json at or above one path.
func piExtensionPackageManifestAt(start string) (map[string]any, bool) {
	current := start
	for {
		file := filepath.Join(current, "package.json")
		if _, err := os.Stat(file); err == nil {
			raw, err := os.ReadFile(file)
			if err != nil {
				return nil, false
			}
			var manifest map[string]any
			if err := json.Unmarshal(raw, &manifest); err != nil {
				return nil, false
			}
			return manifest, true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil, false
		}
		current = parent
	}
}

// PackageGaps reports the relative paths a package declares as its own runtime entry points but
// does not have on disk.
//
// A truncated install — the incident this exists for: `zod` was present under `node_modules` while
// its whole `v4/` directory was missing, so `pi-mcp-adapter` died with `Cannot find module
// './v4/classic/external.js'` — is invisible to a directory check, so completeness has to be
// checked per declared target. Type declarations are ignored here: a package may legitimately ship
// none, and a missing `.d.ts` never stops a load.
func PackageGaps(dir string, rootOnly bool) ([]string, error) {
	manifest, ok := piExtensionPackageManifestAt(dir)
	if !ok {
		return []string{"package.json"}, nil
	}
	targets := map[string]bool{}
	var collect func(value any)
	collect = func(value any) {
		switch typed := value.(type) {
		case string:
			if !strings.Contains(typed, "*") && !piExtensionDeclarationPattern.MatchString(typed) {
				targets[typed] = true
			}
			return
		case []any:
			for _, item := range typed {
				collect(item)
			}
			return
		case map[string]any:
			for key, item := range typed {
				// A subpath export ("./v4/classic/external.js") is a real file the package must ship; a
				// custom condition name ("standard-schema-spec") is not a runtime entry for us and may
				// legitimately point at sources the published package leaves out.
				subpath := strings.HasPrefix(key, ".")
				if !subpath && !piExtensionRuntimeConditions[key] {
					continue
				}
				// "." is the package's own root entry, not a subpath: a dependency only has to satisfy it.
				if rootOnly && subpath && key != "." {
					continue
				}
				collect(item)
			}
		}
	}
	collect(manifest["main"])
	collect(manifest["module"])
	collect(manifest["exports"])
	ordered := make([]string, 0, len(targets))
	for target := range targets {
		ordered = append(ordered, target)
	}
	sort.Strings(ordered)
	gaps := []string{}
	for _, target := range ordered {
		// `main` is often written without a `./` prefix (`ajv` ships `dist/ajv.js`, `cross-spawn`
		// ships `index.js`); only absolute paths and URLs are outside the package.
		if strings.HasPrefix(target, "/") || piExtensionURLPattern.MatchString(target) {
			continue
		}
		relative := strings.TrimPrefix(target, "./")
		if !piExtensionTargetExists(dir, relative) {
			gaps = append(gaps, relative)
		}
	}
	return gaps, nil
}

var piExtensionURLPattern = regexp.MustCompile(`^[a-zA-Z]+:`)

// piExtensionTargetExists applies the same resolution Node itself applies to a plain path: the
// exact file, the file with a runtime extension, or the directory's index. Declaring `main:
// "./index"` while shipping `index.js` is perfectly normal (`ms` does exactly that), and a gap check
// that called such a package broken would reinstall a healthy tree.
func piExtensionTargetExists(dir string, relative string) bool {
	for _, suffix := range []string{"", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs", "/index.cjs", "/index.json"} {
		if _, err := os.Stat(filepath.Join(dir, relative+suffix)); err == nil {
			return true
		}
	}
	return false
}

// InstallRootGaps reports every top-level package in one install root that declares an entry point
// it does not ship.
//
// Diagnostic only: neither a gap nor a snapshot difference proves damage — a published package may
// declare a root entry it never ships (`@modelcontextprotocol/sdk@1.30.1` declares
// `dist/esm/index.js` and the official tarball has no such file), and a change in that tree can be
// another source's legitimate update. The install root is shared by every temporary npm source, so
// resolving one source must never remove it.
func InstallRootGaps(root string) ([]string, error) {
	nodeModules := filepath.Join(root, "node_modules")
	entries, err := os.ReadDir(nodeModules)
	if err != nil {
		return []string{}, nil
	}
	gaps := []string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		names := []string{entry.Name()}
		if strings.HasPrefix(entry.Name(), "@") {
			scoped, err := os.ReadDir(filepath.Join(nodeModules, entry.Name()))
			if err != nil {
				continue
			}
			names = names[:0]
			for _, item := range scoped {
				names = append(names, entry.Name()+"/"+item.Name())
			}
		}
		for _, name := range names {
			dir := filepath.Join(nodeModules, name)
			missing, err := PackageGaps(dir, true)
			if err != nil {
				return nil, err
			}
			if len(missing) > 0 {
				gaps = append(gaps, name+": "+strings.Join(missing, ", "))
			}
		}
	}
	return gaps, nil
}

const piExtensionInstallSnapshotFile = ".graph-install.json"

// piExtensionInstallTree is one digest per installed package: the sorted list of its files.
func piExtensionInstallTree(root string) (map[string]string, error) {
	nodeModules := filepath.Join(root, "node_modules")
	entries, err := os.ReadDir(nodeModules)
	if err != nil {
		return map[string]string{}, nil
	}
	tree := map[string]string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		names := []string{entry.Name()}
		if strings.HasPrefix(entry.Name(), "@") {
			scoped, err := os.ReadDir(filepath.Join(nodeModules, entry.Name()))
			if err != nil {
				continue
			}
			names = names[:0]
			for _, item := range scoped {
				names = append(names, entry.Name()+"/"+item.Name())
			}
		}
		for _, name := range names {
			dir := filepath.Join(nodeModules, name)
			files := []string{}
			err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return nil
				}
				if info.IsDir() {
					return nil
				}
				relative, relErr := filepath.Rel(dir, path)
				if relErr != nil {
					return nil
				}
				files = append(files, relative)
				return nil
			})
			if err != nil {
				return nil, err
			}
			sort.Strings(files)
			sum := sha256.Sum256([]byte(strings.Join(files, "\n")))
			tree[name] = hex.EncodeToString(sum[:])
		}
	}
	return tree, nil
}

// RecordInstallSnapshot records what is installed now; a diagnostic baseline, never a trigger for
// deleting anything.
func RecordInstallSnapshot(root string) error {
	tree, err := piExtensionInstallTree(root)
	if err != nil {
		return err
	}
	body, err := json.Marshal(tree)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, piExtensionInstallSnapshotFile), body, 0o600)
}

// EnsureRequiredPeers installs the peers a package declares but does not ship.
//
// The Pi SDK installs a source with `--omit=peer`, and the host supplies only `@earendil-works/*`
// to loaded extensions, so a plain non-optional peer such as `zod` would never resolve and the
// extension could not load at all. Install those peers into the same root and verify them
// afterwards; an already complete peer is a no-op. A partial npm extraction in that shared root is
// the real failure this guards: the incident left `zod` present but stripped of its whole `v4/`
// directory, with another package's declared entry missing in the same tree, so the presence of a
// directory proves nothing.
func EnsureRequiredPeers(entry string) error {
	root := piExtensionInstallRootFor(entry)
	if root == "" {
		return nil
	}
	manifest, ok := piExtensionPackageManifestAt(filepath.Dir(entry))
	if !ok {
		return nil
	}
	peers, _ := manifest["peerDependencies"].(map[string]any)
	meta, _ := manifest["peerDependenciesMeta"].(map[string]any)
	required := []string{}
	for name := range peers {
		if strings.HasPrefix(name, "@earendil-works/") {
			continue
		}
		if entryMeta, ok := meta[name].(map[string]any); ok {
			if optional, ok := entryMeta["optional"].(bool); ok && optional {
				continue
			}
		}
		required = append(required, name)
	}
	sort.Strings(required)
	if len(required) == 0 {
		return nil
	}
	broken := []string{}
	for _, name := range required {
		dir := filepath.Join(root, "node_modules", name)
		if _, err := os.Stat(dir); err != nil {
			broken = append(broken, name)
			continue
		}
		missing, err := PackageGaps(dir, false)
		if err != nil {
			return err
		}
		if len(missing) > 0 {
			broken = append(broken, name)
		}
	}
	if len(broken) == 0 {
		return nil
	}
	// `--prefer-online` keeps a stale entry in npm's own cache from handing back the very tree that
	// made the peer unloadable. Repair stays best effort on purpose: a static gap check can be wrong
	// about an exotic export map, and turning that guess into a thrown error would block a session
	// that would otherwise load — the load itself stays the authority.
	args := []string{"install"}
	for _, name := range broken {
		version, _ := peers[name].(string)
		args = append(args, name+"@"+version)
	}
	args = append(args, "--prefix", root, "--omit=dev", "--no-save", "--no-audit", "--no-fund", "--prefer-online")
	_, _ = piExtensionRunNpm(args[0], args[1:]...)
	return nil
}

// NpmSourceName is the package name inside an `npm:` source; nil for git and local sources.
func NpmSourceName(source string) *string {
	if !strings.HasPrefix(source, "npm:") {
		return nil
	}
	spec := strings.TrimSpace(strings.TrimPrefix(source, "npm:"))
	if spec == "" {
		return nil
	}
	at := strings.LastIndex(spec, "@")
	name := spec
	if at > 0 {
		name = spec[:at]
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	return &name
}

// piExtensionPackageVersionAt is the version in the nearest package.json above an entry; `name`
// narrows which manifest counts.
func piExtensionPackageVersionAt(entry string, name *string) (*string, error) {
	directory := filepath.Dir(entry)
	for depth := 0; depth < 8; depth++ {
		candidate := filepath.Join(directory, "package.json")
		if _, err := os.Stat(candidate); err == nil {
			raw, err := os.ReadFile(candidate)
			if err == nil {
				var manifest struct {
					Name    string `json:"name"`
					Version string `json:"version"`
				}
				if json.Unmarshal(raw, &manifest) == nil {
					matches := name == nil || manifest.Name == *name
					if matches && manifest.Version != "" {
						version := manifest.Version
						return &version, nil
					}
				}
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	return nil, nil
}

// piExtensionInstallRootOf is the install root npm wrote: the folder that owns the `node_modules`
// the entry lives in.
func piExtensionInstallRootOf(entry string) string {
	at := strings.Index(entry, string(filepath.Separator)+"node_modules"+string(filepath.Separator))
	if at > 0 {
		return entry[:at]
	}
	return ""
}

// piExtensionNpmLatest is the newest version the registry has for a spec.
func piExtensionNpmLatest(spec string, cwd string) *string {
	stdout, err := piExtensionRunCommand("npm", []string{"view", spec, "version", "--json"}, cwd, piExtensionQueryTimeout)
	if err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		return nil
	}
	var single string
	if json.Unmarshal([]byte(trimmed), &single) == nil && single != "" {
		return &single
	}
	var list []string
	if json.Unmarshal([]byte(trimmed), &list) == nil && len(list) > 0 {
		latest := list[len(list)-1]
		return &latest
	}
	return nil
}

// ResolvePiExtensionSourceStatus reports whether a source has a newer version than the one on
// disk. The Pi SDK's own `checkForAvailableUpdates()` only inspects packages configured in its
// settings, and a capability source is resolved in temporary scope, so Graph asks npm itself.
func ResolvePiExtensionSourceStatus(input PiExtensionSourceInput) (PiExtensionSourceStatus, error) {
	piExtensionStatusCacheMu.Lock()
	cached, found := piExtensionStatusCache[input.Source]
	piExtensionStatusCacheMu.Unlock()
	if found && NowMillis()-cached.at < piExtensionStatusCacheMs {
		return cached.status, nil
	}
	resolved, err := ResolvePiExtensionSource(input)
	if err != nil {
		return PiExtensionSourceStatus{}, err
	}
	if len(resolved.Entries) == 0 {
		return PiExtensionSourceStatus{}, errors.New("Pi extension source resolved no extension entry")
	}
	name := NpmSourceName(input.Source)
	installed, err := piExtensionPackageVersionAt(resolved.Entries[0], name)
	if err != nil {
		return PiExtensionSourceStatus{}, err
	}
	var latest *string
	if name != nil {
		latest = piExtensionNpmLatest(strings.TrimSpace(strings.TrimPrefix(input.Source, "npm:")), input.Cwd)
	}
	installGaps := []string{}
	if root := piExtensionInstallRootFor(resolved.Entries[0]); root != "" {
		// Best effort on purpose: a diagnostic that throws would turn "we could not look" into "the
		// extension is broken".
		if gaps, gapErr := InstallRootGaps(root); gapErr == nil {
			installGaps = gaps
		}
	}
	status := PiExtensionSourceStatus{
		Installed:   installed,
		Latest:      latest,
		Available:   name != nil && installed != nil && latest != nil && *installed != *latest,
		InstallGaps: installGaps,
	}
	piExtensionStatusCacheMu.Lock()
	piExtensionStatusCache[input.Source] = piExtensionStatusCacheEntry{at: NowMillis(), status: status}
	piExtensionStatusCacheMu.Unlock()
	return status, nil
}

// UpdatePiExtensionSource installs or upgrades a source the way `pi` itself does it: an explicit
// version reinstalls that spec, an open range or a bare name moves to the newest one.
func UpdatePiExtensionSource(input PiExtensionSourceInput) (PiExtensionUpdateResult, error) {
	return withExtensionInstall(input.AgentDir, func() (PiExtensionUpdateResult, error) {
		resolved, err := resolvePiExtensionSourceOnce(input)
		if err != nil {
			return PiExtensionUpdateResult{}, err
		}
		if len(resolved.Entries) == 0 {
			return PiExtensionUpdateResult{}, errors.New("Pi extension source resolved no extension entry")
		}
		entry := resolved.Entries[0]
		root := piExtensionInstallRootOf(entry)
		if root == "" {
			Raise("capability_unavailable", "Pi extension source "+input.Source+" has no npm install root to update")
		}
		spec := strings.TrimSpace(strings.TrimPrefix(input.Source, "npm:"))
		name := NpmSourceName(input.Source)
		target := spec + "@latest"
		if name != nil && len(spec) > len(*name) {
			target = spec
		}
		if _, err := piExtensionRunNpm("install", target, "--cwd", root); err != nil {
			return PiExtensionUpdateResult{}, err
		}
		piExtensionStatusCacheMu.Lock()
		delete(piExtensionStatusCache, input.Source)
		piExtensionStatusCacheMu.Unlock()
		version, err := piExtensionPackageVersionAt(entry, name)
		if err != nil {
			return PiExtensionUpdateResult{}, err
		}
		return PiExtensionUpdateResult{Updated: true, Version: version}, nil
	})
}

// piExtensionRunNpm runs npm with the Graph environment.
func piExtensionRunNpm(name string, args ...string) (string, error) {
	return piExtensionRunCommand("npm", args, "", piExtensionInstallTimeout)
}

// piExtensionRunCommand runs one helper command and returns its stdout.
func piExtensionRunCommand(name string, args []string, cwd string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = cwd
	command.Env = os.Environ()
	stdout, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("%s %s failed: %w", name, strings.Join(args, " "), err)
	}
	return string(stdout), nil
}
