package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// NewRsiService opens one self-improvement service.
func NewRsiService(options RsiServiceOptions) *RsiService {
	service := &RsiService{stateDir: deployResolve("", options.StateDir)}
	if options.Root != nil && *options.Root != "" {
		root := rsiResolveRoot(*options.Root)
		service.Root = &root
	}
	service.validate = options.Validate
	if service.validate == nil {
		service.validate = rsiDefaultValidate
	}
	if service.Root != nil {
		packageJSON := filepath.Join(*service.Root, "package.json")
		if _, err := os.Stat(packageJSON); err == nil {
			if repo := DetectRepo(*service.Root); repo != nil && *repo == *service.Root {
				service.Available = true
			}
		}
	}
	if service.Available {
		service.runningCommit = RevParse(*service.Root, "HEAD")
	}
	return service
}

var rsiServices = map[string]*RsiService{}

var rsiServicesMu sync.Mutex

// OpenRsiService returns the shared service for one root and state directory.
func OpenRsiService(options RsiServiceOptions) *RsiService {
	key := "unavailable"
	if options.Root != nil {
		key = *options.Root
	}
	key += "\x00" + deployResolve("", options.StateDir)
	rsiServicesMu.Lock()
	defer rsiServicesMu.Unlock()
	if existing, ok := rsiServices[key]; ok {
		return existing
	}
	service := NewRsiService(options)
	rsiServices[key] = service
	return service
}

// ResolveRsiRoot finds the Graph source checkout the daemon runs from.
func ResolveRsiRoot(env map[string]string, cwd string) *string {
	if env == nil {
		env = environMap()
	}
	if configured := strings.TrimSpace(env["GRAPH_RSI_ROOT"]); configured != "" {
		root := rsiResolveRoot(configured)
		return &root
	}
	for _, candidate := range []string{cwd, GraphApplicationRoot()} {
		root := rsiResolveRoot(candidate)
		if _, err := os.Stat(filepath.Join(root, "package.json")); err != nil {
			continue
		}
		if repo := DetectRepo(root); repo != nil && *repo == root {
			return &root
		}
	}
	return nil
}

// rsiResolveRoot realpaths a candidate so symlinked checkouts compare equal to Git's top-level path.
func rsiResolveRoot(path string) string {
	absolute := deployResolve("", path)
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		return resolved
	}
	return absolute
}

// rsiWriteAtomic writes a file through a temporary name, the way the TypeScript service did.
func rsiWriteAtomic(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	pending := fmt.Sprintf("%s.%d.%s.pending", path, os.Getpid(), graphUUID())
	if err := os.WriteFile(pending, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(pending, path)
}

// rsiCommandOutput is the stdout and stderr of one command, bounded to the last 40,000 characters.
func rsiCommandOutput(stdout, stderr string) string {
	parts := []string{}
	if stdout != "" {
		parts = append(parts, stdout)
	}
	if stderr != "" {
		parts = append(parts, stderr)
	}
	joined := strings.TrimSpace(strings.Join(parts, "\n"))
	runes := []rune(joined)
	if len(runes) > 40_000 {
		joined = string(runes[len(runes)-40_000:])
	}
	return joined
}

// rsiAnsiPattern matches the colour codes a test runner prints.
var rsiAnsiPattern = regexp.MustCompile("\x1b\\[[0-9;]*m")

// rsiFailureLine matches the lines a test runner prints for the case that failed.
var rsiFailureLine = regexp.MustCompile(`(^|\s)FAIL |Failed Tests|AssertionError|Matcher did not succeed|Error: |❯ `)
