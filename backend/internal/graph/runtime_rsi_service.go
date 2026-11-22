package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

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
	service.installApp = options.InstallApp
	if service.installApp == nil {
		service.installApp = rsiInstallDesktopApp
	}
	if service.Root != nil {
		if repo := DetectRepo(*service.Root); repo != nil && *repo == *service.Root {
			service.Available = true
		}
	}
	if service.Available {
		rsiPruneStaleSnapshots(*service.Root)
		rsiPruneStaleScratchDirs(time.Now())
		service.runningCommit = RevParse(*service.Root, "HEAD")
	}
	return service
}

var rsiServices = map[string]*RsiService{}

var rsiServicesMu sync.Mutex

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
		if repo := DetectRepo(root); repo != nil && *repo == root {
			return &root
		}
	}
	return nil
}

func rsiResolveRoot(path string) string {
	absolute := deployResolve("", path)
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		return resolved
	}
	return absolute
}

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

var rsiAnsiPattern = regexp.MustCompile("\x1b\\[[0-9;]*m")

var rsiFailureLine = regexp.MustCompile(`(^|\s)FAIL |Failed Tests|AssertionError|Matcher did not succeed|Error: |❯ `)
