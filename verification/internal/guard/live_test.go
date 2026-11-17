package guard

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type liveRun struct {
	root    string
	paths   Paths
	command *exec.Cmd
	log     *os.File
}

func startLiveDaemon(t *testing.T, repo string) *liveRun {
	t.Helper()
	binary := os.Getenv("VERIFY_LIVE_DAEMON")
	if binary == "" {
		binary = filepath.Join(repo, "dist", "graphd")
	}
	if _, err := os.Stat(binary); err != nil {
		t.Skip("no graphd binary at " + binary + "; set VERIFY_LIVE_DAEMON")
	}
	root := filepath.Join(repo, "verification", ".run", fmt.Sprintf("guard-live-%d", time.Now().UnixNano()))
	paths := Paths{
		Repo:      repo,
		Root:      root,
		Home:      filepath.Join(root, "home"),
		StateDir:  filepath.Join(root, "state"),
		GraphHome: filepath.Join(root, "graph-home"),
		Config:    filepath.Join(root, "graph.config.json"),
		DaemonBin: binary,
		AppName:   "guard-live",
	}
	project := filepath.Join(root, "project")
	binDir := filepath.Join(root, "bin")
	for _, dir := range []string{paths.StateDir, paths.GraphHome, project, binDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	payload, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	paths.DaemonBin = filepath.Join(binDir, "graphd")
	if err := os.WriteFile(paths.DaemonBin, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	config := fmt.Sprintf(`{"version":1,"projects":[{"id":"guard","root":%q}]}`, project)
	if err := os.WriteFile(paths.Config, []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureHome(root); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallShim(root); err != nil {
		t.Fatal(err)
	}
	if problems := paths.Validate(); len(problems) != 0 {
		t.Fatalf("the live run is not isolated: %+v", problems)
	}
	logPath := filepath.Join(root, "daemon.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(paths.DaemonBin,
		"--view-only",
		"--state-dir", paths.StateDir,
		"--graph-home", paths.GraphHome,
		"--config", paths.Config,
		"--application-root", repo,
		"--port", "0",
	)
	command.Env = Env(paths, os.Environ())
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		_ = logFile.Close()
		t.Fatalf("cannot start the isolated daemon: %v", err)
	}
	run := &liveRun{root: root, paths: paths, command: command, log: logFile}
	t.Cleanup(func() { run.stop(t) })
	return run
}

func (r *liveRun) stop(t *testing.T) {
	t.Helper()
	if r.command != nil && r.command.Process != nil && ProcessAliveForTest(r.command.Process.Pid) {
		_ = r.command.Process.Signal(syscall.SIGTERM)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) && ProcessAliveForTest(r.command.Process.Pid) {
			time.Sleep(50 * time.Millisecond)
		}
		if ProcessAliveForTest(r.command.Process.Pid) {
			_ = r.command.Process.Kill()
		}
	}
	if r.log != nil {
		_ = r.log.Close()
	}
}

func (r *liveRun) waitReady(t *testing.T, timeout time.Duration) (string, string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		payload, err := os.ReadFile(filepath.Join(r.paths.StateDir, "console.json"))
		if err == nil {
			var console struct {
				URL string `json:"url"`
				PID int    `json:"pid"`
			}
			if json.Unmarshal(payload, &console) == nil && console.URL != "" {
				token, _ := os.ReadFile(filepath.Join(r.paths.StateDir, "session-token"))
				client := &http.Client{Timeout: 2 * time.Second}
				request, err := http.NewRequest("GET", console.URL+"/api/health", nil)
				if err == nil {
					request.Header.Set("Cookie", "graph_session="+strings.TrimSpace(string(token)))
					if response, err := client.Do(request); err == nil {
						body, _ := io.ReadAll(response.Body)
						response.Body.Close()
						if response.StatusCode == 200 {
							return console.URL, strings.TrimSpace(string(token))
						}
						_ = body
					}
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	log, _ := os.ReadFile(filepath.Join(r.root, "daemon.log"))
	t.Fatalf("the isolated daemon did not become ready\n%s", string(log))
	return "", ""
}

func ProcessAliveForTest(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

func TestTheIsolatedDaemonLeavesTheUsersGraphAlone(t *testing.T) {
	if os.Getenv("VERIFY_LIVE") != "1" {
		t.Skip("set VERIFY_LIVE=1 to start a real isolated daemon")
	}
	repo := os.Getenv("VERIFY_REPO")
	if repo == "" {
		t.Fatal("VERIFY_REPO must name the Graph checkout")
	}
	before := Capture("", repo)
	run := startLiveDaemon(t, repo)
	url, token := run.waitReady(t, 60*time.Second)
	if !strings.HasPrefix(url, "http://127.0.0.1:") {
		t.Fatalf("the daemon answered on %q", url)
	}
	if token == "" {
		t.Fatal("no session token was written next to console.json")
	}
	anonymous := &http.Client{Timeout: 5 * time.Second}
	response, err := anonymous.Get(url + "/api/conversations")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatalf("anonymous /api/conversations answered %d, want 401", response.StatusCode)
	}
	withCookie, _ := http.NewRequest("GET", url+"/api/startup", nil)
	withCookie.Header.Set("Cookie", "graph_session="+token)
	response, err = anonymous.Do(withCookie)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(payload), `"mode":"view"`) {
		t.Fatalf("an authenticated /api/startup answered %d %s", response.StatusCode, string(payload))
	}
	run.stop(t)
	time.Sleep(200 * time.Millisecond)

	after := Capture("", repo)
	if diffs := Diff(before, after); len(diffs) != 0 {
		t.Fatalf("the isolated run changed the user's global Graph state: %+v", diffs)
	}
	if log, err := os.ReadFile(run.paths.ShimLog()); err == nil && strings.TrimSpace(string(log)) != "" {
		t.Fatalf("the isolated run called launchctl: %s", string(log))
	}
	entries, err := os.ReadDir(filepath.Join(run.paths.Home, "Library", "LaunchAgents"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the isolated run installed a launch agent: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(run.paths.StateDir, "console.json")); err != nil {
		t.Fatalf("the run's own state disappeared: %v", err)
	}
	if directory := os.Getenv("VERIFY_EVIDENCE_DIR"); directory != "" {
		report := map[string]any{
			"runRoot":      run.root,
			"url":          url,
			"daemonState":  run.paths.StateDir,
			"isolation":    run.paths.Validate(),
			"before":       before,
			"after":        after,
			"globalDiff":   Diff(before, after),
			"capturedAt":   time.Now().UTC(),
			"launchctlLog": readOrEmpty(run.paths.ShimLog()),
		}
		payload, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "guard-live.json"), payload, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func readOrEmpty(path string) string {
	payload, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(payload)
}
