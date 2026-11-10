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
	StateDir   string
	GraphHome  string
	WebDir     string
	ConfigPath string
	SourceRoot string
	DaemonBin  string
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
		StateDir:   envOr("GRAPH_STATE_DIR", filepath.Join(appSupport, "state")),
		GraphHome:  graphHome,
		WebDir:     envOr("GRAPH_WEB_DIR", filepath.Join(root, "dist", "web")),
		ConfigPath: envOr("GRAPH_CONFIG", filepath.Join(appSupport, "graph.config.json")),
		SourceRoot: root,
		DaemonBin:  envOr("GRAPH_DAEMON", filepath.Join(root, "dist", "graphd")),
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

func (paths Paths) DaemonArgs() []string {
	args := []string{
		"--state-dir", paths.StateDir,
		"--graph-home", paths.GraphHome,
		"--web-dir", paths.WebDir,
		"--port", "0",
	}
	if _, err := os.Stat(paths.ConfigPath); err == nil {
		args = append(args, "--config", paths.ConfigPath)
	}
	args = append(args, "--execute", "--dynamic", "--application-root", paths.SourceRoot)
	return args
}

func RouteOf(raw string) (string, bool) {
	const scheme = "graph://"
	if !strings.HasPrefix(raw, scheme) {
		return "", false
	}
	rest := strings.TrimPrefix(raw, scheme)
	rest = strings.TrimSuffix(rest, "/")
	if rest == "" || rest == "open" {
		return "#/", true
	}
	if strings.HasPrefix(rest, "conversations/") {
		id := strings.TrimPrefix(rest, "conversations/")
		if id == "" {
			return "", false
		}
		return "#/conversations/" + id, true
	}
	return "", false
}
