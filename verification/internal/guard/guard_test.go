package guard

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func validPaths(t *testing.T) Paths {
	t.Helper()
	repo := t.TempDir()
	root := filepath.Join(repo, "verification", ".run", "testrun")
	paths := Paths{
		Repo:      repo,
		Root:      root,
		Home:      filepath.Join(root, "home"),
		StateDir:  filepath.Join(root, "state"),
		GraphHome: filepath.Join(root, "graph-home"),
		Config:    filepath.Join(root, "graph.config.json"),
		DaemonBin: filepath.Join(root, "bin", "graphd"),
		AppName:   "graph-ui-testrun",
	}
	for _, dir := range []string{paths.StateDir, paths.GraphHome, filepath.Dir(paths.DaemonBin)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(paths.Config, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.DaemonBin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := EnsureHome(root); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallShim(root); err != nil {
		t.Fatal(err)
	}
	return paths
}

func TestValidateAcceptsAnIsolatedRun(t *testing.T) {
	paths := validPaths(t)
	if problems := paths.Validate(); len(problems) != 0 {
		t.Fatalf("expected no problems, got %+v", problems)
	}
}

func TestValidateRejectsPathsOutsideTheRun(t *testing.T) {
	paths := validPaths(t)
	paths.StateDir = filepath.Join(paths.Repo, "somewhere-else")
	paths.Root = filepath.Join(paths.Repo, "verification", ".run", "other")
	paths.Home = filepath.Join(paths.Root, "home")
	paths.GraphHome = filepath.Join(paths.Root, "graph-home")
	paths.Config = filepath.Join(paths.Root, "graph.config.json")
	paths.DaemonBin = filepath.Join(paths.Root, "bin", "graphd")
	problems := paths.Validate()
	codes := map[string]bool{}
	for _, problem := range problems {
		codes[problem.Code] = true
	}
	for _, wanted := range []string{"outside_run", "launchctl_shim_missing", "home_guard_missing"} {
		if !codes[wanted] {
			t.Fatalf("expected problem %q in %+v", wanted, problems)
		}
	}
}

func TestValidateRejectsTheUsersOwnStateDirectory(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	if _, err := os.Stat(filepath.Join(home, "Library", "LaunchAgents")); err != nil {
		t.Skip("no Library/LaunchAgents on this machine")
	}
	paths := validPaths(t)
	paths.Root = filepath.Join(home, "Library", "Application Support", "Graph", "verify-run")
	problems := paths.Validate()
	for _, problem := range problems {
		if problem.Code == "user_state_dir" {
			return
		}
	}
	t.Fatalf("expected user_state_dir in %+v", problems)
}

func TestEnsureHomeMakesTheLaunchAgentDirectoryReadOnly(t *testing.T) {
	root := filepath.Join(t.TempDir(), "run")
	if err := EnsureHome(root); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "home", "Library", "LaunchAgents"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o222 != 0 {
		t.Fatalf("LaunchAgents is writable: %v", info.Mode().Perm())
	}
	if _, err := os.Create(filepath.Join(root, "home", "Library", "LaunchAgents", "dev.graph.daemon.plist")); err == nil {
		t.Fatal("the app could still install a launch agent")
	}
}

func TestInstallShimFailsAndLogs(t *testing.T) {
	root := filepath.Join(t.TempDir(), "run")
	path, err := InstallShim(root)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(path, "bootout", "gui/501/dev.graph.daemon")
	output, err := command.CombinedOutput()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("shim exit = %v, output %q", err, string(output))
	}
	log, err := os.ReadFile(filepath.Join(root, "logs", "launchctl.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(log), "bootout gui/501/dev.graph.daemon") {
		t.Fatalf("shim log = %q", string(log))
	}
}

func TestEnvRedirectsStateAndPutsTheShimFirst(t *testing.T) {
	paths := validPaths(t)
	base := []string{
		"HOME=/Users/someone",
		"PATH=/opt/homebrew/bin:/usr/bin",
		"GRAPH_STATE_DIR=/Users/someone/Library/Application Support/Graph/state",
		"GRAPH_CONFIG=/Users/someone/graph.config.json",
		"GRAPH_HOME=/Users/someone/.graph",
		"GRAPH_DAEMON=/Applications/Graph.app/Contents/MacOS/Graph",
		"TMPDIR=/var/folders/xx",
		"XDG_RUNTIME_DIR=/tmp/xx",
		"GRAPH_PORT=4173",
		"KEEP_ME=yes",
	}
	environment := Env(paths, base)
	values := map[string]string{}
	for _, entry := range environment {
		name, value, ok := strings.Cut(entry, "=")
		if ok {
			if _, exists := values[name]; exists {
				t.Fatalf("%s is set twice", name)
			}
			values[name] = value
		}
	}
	wanted := map[string]string{
		"HOME":            paths.Home,
		"TMPDIR":          paths.TmpDir(),
		"XDG_RUNTIME_DIR": paths.TmpDir(),
		"GRAPH_STATE_DIR": paths.StateDir,
		"GRAPH_CONFIG":    paths.Config,
		"GRAPH_HOME":      paths.GraphHome,
		"GRAPH_RSI_ROOT":  paths.Repo,
		"GRAPH_DAEMON":    paths.DaemonBin,
		"GRAPH_PORT":      "0",
		"KEEP_ME":         "yes",
	}
	for name, value := range wanted {
		if values[name] != value {
			t.Fatalf("%s = %q, want %q", name, values[name], value)
		}
	}
	if !strings.HasPrefix(values["PATH"], filepath.Join(paths.Root, "bin")+string(os.PathListSeparator)) {
		t.Fatalf("PATH does not start with the shim dir: %q", values["PATH"])
	}
	if strings.Contains(values["PATH"], "/opt/homebrew/bin") {
		t.Fatalf("PATH kept the user entries: %q", values["PATH"])
	}
}

func TestFingerprintDiffSeesPlistAndUserConsoleChanges(t *testing.T) {
	home := t.TempDir()
	repo := t.TempDir()
	stateDir := filepath.Join(home, "Library", "Application Support", "Graph", "state")
	for _, dir := range []string{stateDir, filepath.Join(home, "Library", "LaunchAgents")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	consolePath := filepath.Join(stateDir, "console.json")
	if err := os.WriteFile(consolePath, []byte(`{"url":"http://127.0.0.1:1","pid":42}`), 0o644); err != nil {
		t.Fatal(err)
	}
	plistPath := filepath.Join(home, "Library", "LaunchAgents", "dev.graph.daemon.plist")
	if err := os.WriteFile(plistPath, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := Capture(home, repo)
	if before.UserConsolePID != 42 || before.UserConsoleURL != "http://127.0.0.1:1" {
		t.Fatalf("capture did not read the console: %+v", before)
	}
	if !before.PlistExists || before.PlistSHA == "" {
		t.Fatalf("capture did not read the plist: %+v", before)
	}
	after := before
	after.PlistSHA = "changed"
	after.UserConsolePID = 43
	after.UserConsoleSHA = "changed-too"
	diffs := Diff(before, after)
	fields := map[string]bool{}
	for _, diff := range diffs {
		fields[diff.Field] = true
	}
	for _, wanted := range []string{"plistSha", "userConsolePid", "userConsoleSha"} {
		if !fields[wanted] {
			t.Fatalf("diff missed %q: %+v", wanted, diffs)
		}
	}
	unchanged := Diff(before, before)
	if len(unchanged) != 0 {
		t.Fatalf("identical fingerprints differ: %+v", unchanged)
	}
}

func TestFingerprintRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "guard-before.json")
	fingerprint := Fingerprint{UserConsolePID: 7, PlistSHA: "abc", UserDaemonPIDs: []int{7, 8}}
	if err := SaveFingerprint(path, fingerprint); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadFingerprint(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.UserConsolePID != 7 || loaded.PlistSHA != "abc" || len(loaded.UserDaemonPIDs) != 2 {
		t.Fatalf("round trip lost data: %+v", loaded)
	}
}

func TestRepoStatusDigestTracksDirtyFiles(t *testing.T) {
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "verify@example.com"},
		{"config", "user.name", "verify"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Skipf("git is not usable: %v %s", err, out)
		}
	}
	before := repoStatusDigest(repo)
	if before == "" {
		t.Fatal("no digest for a clean repository")
	}
	if err := os.WriteFile(filepath.Join(repo, "dirty.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	after := repoStatusDigest(repo)
	if before == after {
		t.Fatal("an untracked file did not change the repository digest")
	}
}

func TestRepoStatusDigestIgnoresTheVerificationWorkspace(t *testing.T) {
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "verify@example.com"},
		{"config", "user.name", "verify"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Skipf("git is not usable: %v %s", err, out)
		}
	}
	before := repoStatusDigest(repo)
	if err := os.MkdirAll(filepath.Join(repo, "verification", ".run", "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "verification", ".run", "x", "state.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if after := repoStatusDigest(repo); after != before {
		t.Fatalf("a verification run changed the product repository digest (%s -> %s)", before, after)
	}
	if err := os.WriteFile(filepath.Join(repo, "app.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if after := repoStatusDigest(repo); after == before {
		t.Fatal("a change outside verification/ did not change the digest")
	}
}

func TestPrepareLeavesAValidIsolatedRun(t *testing.T) {
	repo := t.TempDir()
	root := filepath.Join(repo, "verification", ".run", "prepared")
	paths := Paths{
		Repo:      repo,
		Root:      root,
		Home:      filepath.Join(root, "home"),
		StateDir:  filepath.Join(root, "state"),
		GraphHome: filepath.Join(root, "graph-home"),
		Config:    filepath.Join(root, "graph.config.json"),
		DaemonBin: filepath.Join(root, "bin", "graphd"),
	}
	if err := os.MkdirAll(paths.StateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Prepare(paths); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if problems := paths.Validate(); len(problems) != 0 {
		t.Fatalf("prepare left problems: %+v", problems)
	}
}

func TestPrepareRefusesAnUnisolatedRun(t *testing.T) {
	root := filepath.Join(t.TempDir(), "run")
	paths := Paths{Root: root, Home: "/tmp/somewhere-else", StateDir: "/tmp/state"}
	if err := Prepare(paths); err == nil || !strings.Contains(err.Error(), "outside_run") {
		t.Fatalf("prepare accepted an unisolated run: %v", err)
	}
}
