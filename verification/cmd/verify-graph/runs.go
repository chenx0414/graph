package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type daemonMeta struct {
	PID   int    `json:"pid"`
	Start string `json:"start"`
	URL   string `json:"url"`
	Log   string `json:"log"`
	Mode  string `json:"mode"`
}

type runMeta struct {
	RunID     string     `json:"runId"`
	CreatedAt string     `json:"createdAt"`
	ExpiresAt string     `json:"expiresAt,omitempty"`
	StateDir  string     `json:"stateDir"`
	GraphHome string     `json:"graphHome"`
	Config    string     `json:"config"`
	Home      string     `json:"home"`
	Tmp       string     `json:"tmp"`
	Runtime   string     `json:"runtime"`
	Bin       string     `json:"bin"`
	Logs      string     `json:"logs"`
	Daemon    daemonMeta `json:"daemon"`
	GitHead   string     `json:"gitHead,omitempty"`
	CLI       string     `json:"cliVersion"`
}

type paths struct {
	Verification string
	Repo         string
	RunRoot      string
	EvidenceRoot string
	AppDir       string
	BackendDir   string
}

func locate() (paths, error) {
	candidates := []string{}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for i := 0; i < 4; i++ {
			candidates = append(candidates, dir)
			dir = filepath.Dir(dir)
		}
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(filepath.Join(candidate, "cmd", "verify-graph", "main.go")); err != nil {
			continue
		}
		absolute, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		return paths{
			Verification: absolute,
			Repo:         filepath.Dir(absolute),
			RunRoot:      filepath.Join(absolute, ".run"),
			EvidenceRoot: filepath.Join(absolute, "evidence"),
			AppDir:       filepath.Join(filepath.Dir(absolute), "app"),
			BackendDir:   filepath.Join(filepath.Dir(absolute), "backend"),
		}, nil
	}
	return paths{}, fmt.Errorf("cannot locate the verification directory (run the CLI from verification/ or its wrapper)")
}

func newRunID() string {
	var buffer [4]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer[:])
}

func lstart(pid int) string {
	output, err := exec.Command("ps", "-o", "lstart=", "-p", fmt.Sprint(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func gitHead(repo string) string {
	output, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func prepareRun(p paths, runID string) (runMeta, error) {
	if runID == "" {
		runID = newRunID()
	}
	base := filepath.Join(p.RunRoot, runID)
	meta := runMeta{
		RunID:     runID,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		ExpiresAt: time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339),
		StateDir:  filepath.Join(base, "state"),
		GraphHome: filepath.Join(base, "graph-home"),
		Config:    filepath.Join(base, "graph.config.json"),
		Home:      filepath.Join(base, "home"),
		Tmp:       filepath.Join(base, "tmp"),
		Runtime:   filepath.Join(base, "runtime"),
		Bin:       filepath.Join(base, "bin"),
		Logs:      filepath.Join(base, "logs"),
		GitHead:   gitHead(p.Repo),
		CLI:       version,
	}
	for _, dir := range []string{meta.StateDir, meta.GraphHome, meta.Home, meta.Tmp, meta.Runtime, meta.Bin, meta.Logs} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return runMeta{}, err
		}
	}
	project := filepath.Join(base, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		return runMeta{}, err
	}
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("# verification fixture project\n"), 0o644); err != nil {
		return runMeta{}, err
	}
	if err := writeFixtureGraphHome(meta.GraphHome); err != nil {
		return runMeta{}, err
	}
	config := map[string]any{"version": 1, "projects": []map[string]any{{"id": "verify", "root": project}}}
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return runMeta{}, err
	}
	if err := os.WriteFile(meta.Config, append(raw, '\n'), 0o644); err != nil {
		return runMeta{}, err
	}
	return meta, nil
}

func writeFixtureGraphHome(home string) error {
	files := map[string]string{
		"prompts/agents/main.md":    "Fixture agent prompt for verification runs.\n",
		"prompts/rules/common.md":   "- Verification fixture rules. Do not run real work.\n",
		"prompts/rules/worker.md":   "- Verification fixture worker rules.\n",
		"prompts/rules/main.md":     "- Verification fixture main rules.\n",
		"prompts/rules/reviewer.md": "- Verification fixture reviewer rules.\n",
		"prompts/runtime/node.md":   "Fixture node runtime prompt.\n",
		"prompts/runtime/worker.md": "Fixture worker runtime prompt.\n",
		"prompts/tools/main.md":     "- Fixture main tools.\n",
		"prompts/tools/worker.md":   "- Fixture worker tools.\n",
		"prompts/tools/reviewer.md": "- Fixture reviewer tools.\n",
	}
	for name, body := range files {
		path := filepath.Join(home, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func insideRun(meta runMeta, path string) bool {
	base := filepath.Join(filepath.Dir(meta.StateDir))
	absolute, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	base, err = filepath.Abs(base)
	if err != nil {
		return false
	}
	return absolute == base || strings.HasPrefix(absolute, base+string(filepath.Separator))
}

type launchOptions struct {
	RunID   string
	Mode    string
	Timeout time.Duration
	DryRun  bool
	Seed    bool
}

func ensureDaemonBinary(p paths) (string, error) {
	binary := filepath.Join(p.RunRoot, "bin", "graphd")
	if info, err := os.Stat(binary); err == nil && info.Mode()&0o111 != 0 {
		return binary, nil
	}
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		return "", err
	}
	command := exec.Command("go", "build", "-o", binary, "./cmd/graphd")
	command.Dir = p.BackendDir
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("go build ./cmd/graphd failed: %v\n%s", err, strings.TrimSpace(string(output)))
	}
	return binary, nil
}

func launch(p paths, options launchOptions) (envelope, error) {
	mode := options.Mode
	if mode == "" {
		mode = "view"
	}
	if mode != "view" && mode != "execute" {
		return failEnvelope("launch", "api", codeUsage, "unknown mode "+mode, "use --mode view or --mode execute"), nil
	}
	binary, err := ensureDaemonBinary(p)
	if err != nil {
		return failEnvelope("launch", "api", codeBuildFailed, err.Error(), "run: verify-graph build --component daemon"), nil
	}
	meta, err := prepareRun(p, options.RunID)
	if err != nil {
		return failEnvelope("launch", "api", codeUsage, err.Error(), "check that verification/.run is writable"), nil
	}
	for _, path := range []string{meta.StateDir, meta.GraphHome, meta.Config, meta.Home, meta.Tmp, meta.Runtime, meta.Bin, meta.Logs} {
		if !insideRun(meta, path) {
			return failEnvelope("launch", "api", codeIsolation,
				"refusing to launch: "+path+" is outside "+filepath.Dir(meta.StateDir),
				"report this as a bug; the run must stay inside verification/.run/<runId>"), nil
		}
	}
	if options.Seed && mode != "execute" {
		return failEnvelope("launch", "api", codeUsage,
			"--seed needs a dispatchable instance",
			"run: verify-graph launch --mode execute --seed"), nil
	}
	if options.DryRun {
		data := map[string]any{"runId": meta.RunID, "stateDir": meta.StateDir, "config": meta.Config, "binary": binary, "dryRun": true, "seed": options.Seed}
		return okEnvelope("launch", "api", data), nil
	}
	seeded := seedRecord{}
	if options.Seed {
		record, seedErr := startSeed(p, meta)
		if seedErr != nil {
			return failEnvelope("launch", "api", codeDaemonDown, seedErr.Error(),
				"the stub model must answer before the daemon can dispatch; check verification/.run logs"), nil
		}
		if err := writeSeedConfig(meta, record); err != nil {
			_ = stopSeed(meta)
			return failEnvelope("launch", "api", codeUsage, "cannot write the seeded config: "+err.Error(), "check permissions on verification/.run"), nil
		}
		seeded = record
	}
	logPath := filepath.Join(meta.Logs, "daemon.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		return failEnvelope("launch", "api", codeUsage, err.Error(), "check permissions on verification/.run"), nil
	}
	defer logFile.Close()
	args := []string{"--state-dir", meta.StateDir, "--graph-home", meta.GraphHome,
		"--config", meta.Config, "--port", "0", "--application-root", p.Repo}
	if mode == "view" {
		args = append(args, "--view-only")
	} else {
		args = append(args, "--execute", "--dynamic")
	}
	// Keep the daemon under a live keeper shell instead of spawning it directly.
	// This CLI exits right after `launch`, so a direct child is reparented to pid
	// 1; the app treats any daemon whose ppid is 1 as launchd-supervised
	// (app/launchd.go:daemonSupervised) and its window refresh path bootouts and
	// stops it before the window can attach. With a keeper parent the window
	// adopts the daemon untouched, which is what makes a multi-step window
	// journey possible (AppPID + daemon both stay alive).
	keeperPath := filepath.Join(filepath.Dir(meta.StateDir), "keeper.sh")
	if err := os.WriteFile(keeperPath, []byte(keeperSource), 0o755); err != nil {
		return failEnvelope("launch", "api", codeUsage, err.Error(), "check permissions on verification/.run"), nil
	}
	pidPath := filepath.Join(filepath.Dir(meta.StateDir), "daemon.pid")
	_ = os.Remove(pidPath)
	command := exec.Command("/bin/sh", append([]string{keeperPath, binary}, args...)...)
	command.Dir = p.Repo
	command.Stdout = logFile
	command.Stderr = logFile
	environment := append(os.Environ(),
		"HOME="+meta.Home,
		"TMPDIR="+meta.Tmp,
		"XDG_RUNTIME_DIR="+meta.Runtime,
		"GRAPH_STATE_DIR="+meta.StateDir,
		"GRAPH_CONFIG="+meta.Config,
		"GRAPH_HOME="+meta.GraphHome,
		"GRAPH_RSI_ROOT="+p.Repo,
		"VG_DAEMON_PIDFILE="+pidPath,
	)
	if seeded.BaseURL != "" {
		environment = append(environment, seedEnv(seeded)...)
	}
	command.Env = environment
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return failEnvelope("launch", "api", codeDaemonDown, err.Error(), "run: verify-graph doctor"), nil
	}
	keeperPID := command.Process.Pid
	startedPID := waitForDaemonPID(pidPath, keeperPID, 5*time.Second)
	meta.Daemon = daemonMeta{PID: startedPID, Start: lstart(startedPID), Log: logPath, Mode: mode}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	deadline := time.Now().Add(timeout)
	var console consoleFile
	ready := false
	for time.Now().Before(deadline) {
		if value, found := readConsole(meta.StateDir); found && value.PID == startedPID {
			client := newAPIClient(value.URL, readToken(meta.StateDir))
			status, err := client.getJSON("/api/health", nil)
			if err == nil && status == 200 {
				console = value
				ready = true
				break
			}
		}
		if !alive(startedPID) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !ready {
		_ = syscall.Kill(keeperPID, syscall.SIGTERM)
		_ = syscall.Kill(startedPID, syscall.SIGTERM)
		failure := failEnvelope("launch", "api", codeDaemonDown,
			"the isolated daemon did not become ready within "+timeout.String(),
			"read the daemon log named in data.logTail: the usual cause is a missing --config or a port that another run already holds")
		failure.Data = map[string]any{"logTail": tailFile(logPath, 40), "log": logPath, "pid": startedPID}
		return failure, nil
	}
	meta.Daemon.URL = console.URL
	if err := writeRunMeta(p, meta); err != nil {
		return failEnvelope("launch", "api", codeUsage, err.Error(), "check permissions on verification/.run"), nil
	}
	data := map[string]any{
		"runId": meta.RunID, "url": console.URL, "pid": startedPID, "keeperPid": keeperPID, "mode": console.Mode,
		"stateDir": meta.StateDir, "graphHome": meta.GraphHome, "config": meta.Config,
		"log": logPath, "expiresAt": meta.ExpiresAt,
	}
	if seeded.BaseURL != "" {
		data["seed"] = map[string]any{"baseUrl": seeded.BaseURL, "model": seeded.Model, "pid": seeded.PID}
	}
	result := okEnvelope("launch", "api", data)
	result.RunID = meta.RunID
	result.next("verify-graph api GET /api/startup --run %s", meta.RunID)
	result.next("verify-graph verify --run %s --all", meta.RunID)
	return result, nil
}

func writeRunMeta(p paths, meta runMeta) error {
	raw, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(p.RunRoot, meta.RunID, "run.json"), append(raw, '\n'), 0o644)
}

func readRunMeta(p paths, runID string) (runMeta, error) {
	if runID == "" {
		return runMeta{}, fmt.Errorf("no run id given")
	}
	raw, err := os.ReadFile(filepath.Join(p.RunRoot, runID, "run.json"))
	if err != nil {
		return runMeta{}, err
	}
	var meta runMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return runMeta{}, err
	}
	return meta, nil
}

func listRuns(p paths) ([]runMeta, error) {
	entries, err := os.ReadDir(p.RunRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return []runMeta{}, nil
		}
		return nil, err
	}
	runs := []runMeta{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		meta, err := readRunMeta(p, entry.Name())
		if err != nil {
			continue
		}
		runs = append(runs, meta)
	}
	return runs, nil
}

func stopRun(p paths, meta runMeta) error {
	if meta.Daemon.PID == 0 {
		return nil
	}
	if !alive(meta.Daemon.PID) {
		return nil
	}
	if recorded := meta.Daemon.Start; recorded != "" && lstart(meta.Daemon.PID) != recorded {
		return fmt.Errorf("refusing to stop pid %d: it is not the process this run started", meta.Daemon.PID)
	}
	_ = syscall.Kill(meta.Daemon.PID, syscall.SIGTERM)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !alive(meta.Daemon.PID) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = syscall.Kill(meta.Daemon.PID, syscall.SIGKILL)
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !alive(meta.Daemon.PID) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("pid %d did not exit after SIGTERM and SIGKILL", meta.Daemon.PID)
}

func (m runMeta) isZero() bool { return m.RunID == "" && m.Daemon.PID == 0 }

func runAlive(meta runMeta) bool {
	if meta.Daemon.PID == 0 || !alive(meta.Daemon.PID) {
		return false
	}
	return meta.Daemon.Start == "" || lstart(meta.Daemon.PID) == meta.Daemon.Start
}

type daemonProcess struct {
	PID      int    `json:"pid"`
	Start    string `json:"start"`
	StateDir string `json:"stateDir"`
	Command  string `json:"command"`
}

func scanDaemons(p paths) []daemonProcess {
	output, err := exec.Command("ps", "-eo", "pid,lstart,command").Output()
	if err != nil {
		return nil
	}
	found := []daemonProcess{}
	for _, line := range strings.Split(string(output), "\n") {
		if !strings.Contains(line, "graphd") || !strings.Contains(line, p.Verification) {
			continue
		}
		// The daemon keeper shell has the daemon's whole command line in its
		// argv, so it would otherwise look like a second daemon. It is a parent
		// of a live run, never an orphan.
		if strings.Contains(line, "keeper.sh") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid := 0
		fmt.Sscanf(fields[0], "%d", &pid)
		stateDir := ""
		for index, field := range fields {
			if field == "--state-dir" && index+1 < len(fields) {
				stateDir = fields[index+1]
			}
		}
		found = append(found, daemonProcess{PID: pid, Start: lstart(pid), StateDir: stateDir, Command: strings.TrimSpace(line)})
	}
	return found
}

