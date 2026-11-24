package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Console struct {
	URL       string `json:"url"`
	PID       int    `json:"pid"`
	Mode      string `json:"mode"`
	StartedAt int64  `json:"startedAt"`
}

type Paths struct {
	StateDir        string
	GraphHome       string
	ConfigPath      string
	SourceRoot      string
	DaemonBin       string
	LaunchAgentFile string
}

const daemonModeArg = "daemon"

func inDaemonMode(args []string) bool {
	return len(args) > 0 && args[0] == daemonModeArg
}

// screenshotModeArg is the verb the verification CLI runs: one window rendered to a PNG, then
// the process exits. It reuses the same argument dispatch as daemon mode rather than adding a
// second binary.
const screenshotModeArg = "screenshot"

func inScreenshotMode(args []string) bool {
	return len(args) > 0 && args[0] == screenshotModeArg
}

const driveModeArg = "drive"

func inDriveMode(args []string) bool {
	return len(args) > 0 && args[0] == driveModeArg
}

func selfExecutable() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return path
}

func DefaultPaths() Paths {
	home, _ := os.UserHomeDir()
	appSupport := filepath.Join(home, "Library", "Application Support", "Graph")
	graphHome := envOr("GRAPH_HOME", filepath.Join(home, ".graph"))
	root := envOr("GRAPH_RSI_ROOT", appRoot(graphHome))
	if root == "" {
		root, _ = os.Getwd()
	}
	paths := Paths{
		StateDir:        envOr("GRAPH_STATE_DIR", filepath.Join(appSupport, "state")),
		GraphHome:       graphHome,
		ConfigPath:      envOr("GRAPH_CONFIG", filepath.Join(appSupport, "graph.config.json")),
		SourceRoot:      root,
		DaemonBin:       envOr("GRAPH_DAEMON", selfExecutable()),
		LaunchAgentFile: launchAgentPath(),
	}
	return paths
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func appRoot(graphHome string) string {
	payload, err := os.ReadFile(filepath.Join(graphHome, "app-root"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(payload))
}

func (paths Paths) ReadConsole() (Console, bool) {
	var info Console
	payload, err := os.ReadFile(filepath.Join(paths.StateDir, "console.json"))
	if err != nil {
		return info, false
	}
	if err := json.Unmarshal(payload, &info); err != nil || info.URL == "" {
		return Console{}, false
	}
	return info, true
}

func (paths Paths) SessionToken() string {
	payload, err := os.ReadFile(filepath.Join(paths.StateDir, "session-token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(payload))
}

func (paths Paths) Reachable(address string) bool {
	if strings.TrimSpace(address) == "" {
		return false
	}
	request, err := http.NewRequest("GET", strings.TrimSuffix(address, "/")+"/api/conversations", nil)
	if err != nil {
		return false
	}
	if token := paths.SessionToken(); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func (paths Paths) DaemonCommand() []string {
	return append([]string{daemonModeArg}, paths.DaemonArgs()...)
}

func (paths Paths) daemonStale(info Console) bool {
	if info.StartedAt <= 0 {
		return false
	}
	stamp, ok := executableStamp(paths.daemonLauncher())
	if !ok {
		return false
	}
	return stamp.Mod.UnixMilli() > info.StartedAt
}

func (paths Paths) DaemonArgs() []string {
	args := []string{
		"--state-dir", paths.StateDir,
		"--graph-home", paths.GraphHome,
		"--port", "0",
	}
	if _, err := os.Stat(paths.ConfigPath); err == nil {
		args = append(args, "--config", paths.ConfigPath)
	}
	args = append(args, "--execute", "--dynamic", "--application-root", paths.SourceRoot)
	return args
}
