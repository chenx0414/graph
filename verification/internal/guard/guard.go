package guard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Paths struct {
	Repo      string
	Root      string
	Home      string
	StateDir  string
	GraphHome string
	Config    string
	DaemonBin string
	AppName   string
}

const launchAgentLabel = "dev.graph.daemon"

func (p Paths) ShimPath() string { return filepath.Join(p.Root, "bin", "launchctl") }
func (p Paths) ShimLog() string  { return filepath.Join(p.Root, "logs", "launchctl.log") }
func (p Paths) TmpDir() string   { return filepath.Join(p.Root, "tmp") }

type Problem struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

func (p Paths) Validate() []Problem {
	problems := []Problem{}
	add := func(code, detail string) { problems = append(problems, Problem{Code: code, Detail: detail}) }
	if p.Root == "" || !filepath.IsAbs(p.Root) {
		add("root_not_absolute", fmt.Sprintf("run root %q must be absolute", p.Root))
		return problems
	}
	root := filepath.Clean(p.Root)
	inside := func(label, path string) {
		if path == "" {
			add("missing_path", label+" is empty")
			return
		}
		clean := filepath.Clean(path)
		if clean != root && !strings.HasPrefix(clean, root+string(os.PathSeparator)) {
			add("outside_run", fmt.Sprintf("%s=%s is outside the run root %s", label, clean, root))
		}
	}
	inside("state dir", p.StateDir)
	inside("graph home", p.GraphHome)
	inside("config", p.Config)
	inside("daemon binary", p.DaemonBin)
	inside("home", p.Home)
	if p.Repo != "" {
		verificationRoot := filepath.Join(p.Repo, "verification")
		if root != verificationRoot && !strings.HasPrefix(root, verificationRoot+string(os.PathSeparator)) {
			add("outside_workspace", fmt.Sprintf("run root %s is outside %s", root, verificationRoot))
		}
		if strings.Contains(root, filepath.Join("Library", "Application Support", "Graph")) {
			add("user_state_dir", "run root points at the user's Graph application support directory")
		}
	}
	if info, err := os.Stat(p.ShimPath()); err != nil {
		add("launchctl_shim_missing", "no shim at "+p.ShimPath())
	} else if info.Mode().Perm()&0o111 == 0 {
		add("launchctl_shim_not_executable", p.ShimPath()+" is not executable")
	}
	if info, err := os.Stat(filepath.Join(p.Home, "Library", "LaunchAgents")); err != nil {
		add("home_guard_missing", "no read-only LaunchAgents directory under "+p.Home)
	} else if info.Mode().Perm()&0o222 != 0 {
		add("home_guard_writable", fmt.Sprintf("%s is writable (%v); the app could install a real launch agent", filepath.Join(p.Home, "Library", "LaunchAgents"), info.Mode().Perm()))
	}
	return problems
}

func InstallShim(root string) (string, error) {
	binDir := filepath.Join(root, "bin")
	logDir := filepath.Join(root, "logs")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return "", err
	}
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(binDir, "launchctl")
	script := "#!/bin/sh\n" +
		"printf '%s %s\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \"$*\" >> " + shellQuote(filepath.Join(logDir, "launchctl.log")) + "\n" +
		"echo 'verify-graph: launchctl is disabled for this isolated run' >&2\n" +
		"exit 1\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		return "", err
	}
	if err := os.Chmod(path, 0o755); err != nil {
		return "", err
	}
	return path, nil
}

func EnsureHome(root string) error {
	home := filepath.Join(root, "home")
	launchAgents := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(launchAgents, 0o755); err != nil {
		return err
	}
	for _, dir := range []string{
		filepath.Join(home, "Library", "Application Support"),
		filepath.Join(home, "Library", "Preferences"),
		filepath.Join(home, "Library", "Caches"),
		filepath.Join(root, "tmp"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.Chmod(launchAgents, 0o555)
}

var overriddenEnv = []string{
	"HOME", "TMPDIR", "XDG_RUNTIME_DIR", "PATH",
	"GRAPH_STATE_DIR", "GRAPH_CONFIG", "GRAPH_HOME", "GRAPH_RSI_ROOT", "GRAPH_DAEMON", "GRAPH_PORT",
}

func Env(p Paths, base []string) []string {
	keep := make([]string, 0, len(base))
	for _, entry := range base {
		name, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		skip := false
		for _, overridden := range overriddenEnv {
			if name == overridden {
				skip = true
				break
			}
		}
		if !skip {
			keep = append(keep, entry)
		}
	}
	keep = append(keep,
		"HOME="+p.Home,
		"TMPDIR="+p.TmpDir(),
		"XDG_RUNTIME_DIR="+p.TmpDir(),
		"PATH="+filepath.Join(p.Root, "bin")+":/usr/bin:/bin:/usr/sbin:/sbin",
		"GRAPH_STATE_DIR="+p.StateDir,
		"GRAPH_CONFIG="+p.Config,
		"GRAPH_HOME="+p.GraphHome,
		"GRAPH_RSI_ROOT="+p.Repo,
		"GRAPH_DAEMON="+p.DaemonBin,
		"GRAPH_PORT=0",
	)
	sort.Strings(keep)
	return keep
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

type Fingerprint struct {
	CapturedAt          time.Time `json:"capturedAt"`
	UserConsolePath     string    `json:"userConsolePath"`
	UserConsoleSHA      string    `json:"userConsoleSha,omitempty"`
	UserConsolePID      int       `json:"userConsolePid,omitempty"`
	UserConsoleURL      string    `json:"userConsoleUrl,omitempty"`
	PlistPath           string    `json:"plistPath"`
	PlistSHA            string    `json:"plistSha,omitempty"`
	PlistExists         bool      `json:"plistExists"`
	LaunchAgentState    string    `json:"launchAgentState"`
	AppSupportDigest    string    `json:"appSupportDigest,omitempty"`
	RepoStatusSHA       string    `json:"repoStatusSha,omitempty"`
	UserDaemonPIDs      []int     `json:"userDaemonPids,omitempty"`
	UserDaemonProcesses []string  `json:"userDaemonProcesses,omitempty"`
}

type Change struct {
	Field  string `json:"field"`
	Before string `json:"before"`
	After  string `json:"after"`
}

func Capture(home, repo string) Fingerprint {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	fingerprint := Fingerprint{
		CapturedAt:       time.Now().UTC(),
		UserConsolePath:  filepath.Join(home, "Library", "Application Support", "Graph", "state", "console.json"),
		PlistPath:        filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist"),
		LaunchAgentState: launchAgentState(),
	}
	fingerprint.UserConsoleSHA = digestFile(fingerprint.UserConsolePath)
	fingerprint.UserConsolePID, fingerprint.UserConsoleURL = consoleIdentity(fingerprint.UserConsolePath)
	fingerprint.PlistExists = fileExists(fingerprint.PlistPath)
	fingerprint.PlistSHA = digestFile(fingerprint.PlistPath)
	fingerprint.AppSupportDigest = digestDir(filepath.Join(home, "Library", "Application Support", "Graph"))
	fingerprint.RepoStatusSHA = repoStatusDigest(repo)
	fingerprint.UserDaemonPIDs, fingerprint.UserDaemonProcesses = userDaemons(filepath.Join(home, "Library", "Application Support", "Graph", "state"))
	return fingerprint
}

func Diff(before, after Fingerprint) []Change {
	diffs := []Change{}
	compare := func(field, beforeValue, afterValue string) {
		if beforeValue != afterValue {
			diffs = append(diffs, Change{Field: field, Before: beforeValue, After: afterValue})
		}
	}
	compare("userConsoleSha", before.UserConsoleSHA, after.UserConsoleSHA)
	compare("userConsolePid", strconv.Itoa(before.UserConsolePID), strconv.Itoa(after.UserConsolePID))
	compare("plistSha", before.PlistSHA, after.PlistSHA)
	compare("plistExists", strconv.FormatBool(before.PlistExists), strconv.FormatBool(after.PlistExists))
	compare("launchAgentState", before.LaunchAgentState, after.LaunchAgentState)
	compare("appSupportDigest", before.AppSupportDigest, after.AppSupportDigest)
	compare("repoStatusSha", before.RepoStatusSHA, after.RepoStatusSHA)
	compare("userDaemonPids", joinInts(before.UserDaemonPIDs), joinInts(after.UserDaemonPIDs))
	return diffs
}

func SaveFingerprint(path string, fingerprint Fingerprint) error {
	payload, err := json.MarshalIndent(fingerprint, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o644)
}

func LoadFingerprint(path string) (Fingerprint, error) {
	var fingerprint Fingerprint
	payload, err := os.ReadFile(path)
	if err != nil {
		return fingerprint, err
	}
	return fingerprint, json.Unmarshal(payload, &fingerprint)
}

func digestFile(path string) string {
	payload, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func consoleIdentity(path string) (int, string) {
	var console struct {
		URL string `json:"url"`
		PID int    `json:"pid"`
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return 0, ""
	}
	if json.Unmarshal(payload, &console) != nil {
		return 0, ""
	}
	return console.PID, console.URL
}

func digestDir(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "missing"
	}
	parts := []string{}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s:%d:%d", entry.Name(), info.Size(), info.ModTime().UnixNano()))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])
}

func repoStatusDigest(repo string) string {
	if repo == "" {
		return ""
	}
	out, err := exec.Command("git", "-C", repo, "status", "--porcelain=v1", "--untracked-files=all",
		"--", ".", ":(exclude)verification").Output()
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(out)
	return hex.EncodeToString(sum[:])
}

func launchAgentState() string {
	uid := os.Getuid()
	out, err := exec.Command("launchctl", "print", fmt.Sprintf("gui/%d/%s", uid, launchAgentLabel)).CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		if strings.Contains(text, "Could not find service") {
			return "absent"
		}
		return "unknown: " + firstLine(text)
	}
	return "present"
}

func userDaemons(stateDir string) ([]int, []string) {
	out, err := exec.Command("ps", "-axo", "pid=,command=").Output()
	if err != nil {
		return nil, nil
	}
	pids := []int{}
	commands := []string{}
	marker := filepath.Join(stateDir, "")
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "--state-dir") || !strings.Contains(line, marker) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		pids = append(pids, pid)
		commands = append(commands, line)
	}
	sort.Ints(pids)
	return pids, commands
}

func firstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		return text[:index]
	}
	return text
}

func joinInts(values []int) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, strconv.Itoa(value))
	}
	return strings.Join(parts, ",")
}

func Prepare(p Paths) error {
	if err := os.MkdirAll(p.Root, 0o755); err != nil {
		return err
	}
	if err := EnsureHome(p.Root); err != nil {
		return err
	}
	if _, err := InstallShim(p.Root); err != nil {
		return err
	}
	if problems := p.Validate(); len(problems) > 0 {
		parts := make([]string, 0, len(problems))
		for _, problem := range problems {
			parts = append(parts, problem.Code+": "+problem.Detail)
		}
		return fmt.Errorf("the run is not isolated: %s", strings.Join(parts, "; "))
	}
	return nil
}
