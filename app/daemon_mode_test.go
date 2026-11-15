package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDaemonCommandRunsTheShellBinaryInDaemonMode(t *testing.T) {
	paths := Paths{
		StateDir:   "/state",
		GraphHome:  "/home",
		SourceRoot: "/src",
		DaemonBin:  "/Applications/Graph.app/Contents/MacOS/Graph",
	}
	command := paths.DaemonCommand()
	if daemonModeArg != "daemon" {
		t.Fatalf("the daemon mode argument is the contract between the shell and the daemon it starts, got %q", daemonModeArg)
	}
	if len(command) == 0 || command[0] != daemonModeArg {
		t.Fatalf("the daemon must be started in daemon mode, got %v", command)
	}
	joined := strings.Join(command, " ")
	for _, want := range []string{"--state-dir /state", "--graph-home /home", "--execute", "--application-root /src"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("the daemon command is missing %q: %v", want, command)
		}
	}
	if !inDaemonMode(command) {
		t.Fatalf("a daemon command must switch the binary into the daemon, got %v", command)
	}
	if inDaemonMode([]string{"--state-dir", "/state"}) {
		t.Fatal("a plain launch must open the window, not become the daemon")
	}
	if inDaemonMode(nil) || inDaemonMode([]string{"-psn_0_12345"}) {
		t.Fatal("a launch by the Finder passes system arguments and must still open the window")
	}
}

func TestLaunchAgentRunsTheStableCopyInDaemonMode(t *testing.T) {
	dir := t.TempDir()
	paths := Paths{
		StateDir:   filepath.Join(dir, "state"),
		GraphHome:  filepath.Join(dir, "graph-home"),
		SourceRoot: dir,
		DaemonBin:  filepath.Join(dir, "Graph"),
	}
	plist := string(launchAgentPlist(paths, nil))
	stable := stableDaemonPath(paths)
	want := "<string>" + stable + "</string>\n\t\t<string>" + daemonModeArg + "</string>\n\t\t<string>--state-dir</string>"
	if !strings.Contains(plist, want) {
		t.Fatalf("launchd must start the stable copy of the same binary in daemon mode, got:\n%s", plist)
	}
}

func TestTheShellHandsItsOwnBinaryToTheDaemon(t *testing.T) {
	t.Setenv("GRAPH_DAEMON", "")
	paths := DefaultPaths()
	executable, err := os.Executable()
	if err != nil {
		t.Skip("no executable path in this environment: ", err)
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	if paths.DaemonBin != executable {
		t.Fatalf("the shell must run its own binary as the daemon, so the installed app carries the daemon it runs; got %q for %q", paths.DaemonBin, executable)
	}
	if strings.Contains(paths.DaemonBin, filepath.Join("dist", "graphd")) {
		t.Fatal("the installed app must not read the daemon out of a build directory")
	}
}

func TestRefreshInstallsTheBinaryLaunchdWillRunBeforeItRestartsTheAgent(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "Graph")
	if err := os.WriteFile(source, []byte("merged binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	console := `{"url":"http://127.0.0.1:1","pid":1,"mode":"execute","startedAt":1}`
	if err := os.WriteFile(filepath.Join(stateDir, "console.json"), []byte(console), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := Paths{
		StateDir:        stateDir,
		GraphHome:       filepath.Join(dir, "graph-home"),
		SourceRoot:      dir,
		DaemonBin:       source,
		LaunchAgentFile: filepath.Join(dir, "dev.graph.daemon.plist"),
	}
	if result := newDaemon(paths).refresh(); !result.restart {
		t.Fatal("a running daemon whose binary and agent changed must be reported as needing a restart")
	}
	installed, err := os.ReadFile(stableDaemonPath(paths))
	if err != nil {
		t.Fatalf("the agent restarts the stable copy, so refresh must write it first: %v", err)
	}
	if string(installed) != "merged binary" {
		t.Fatalf("the stable copy holds %q, so launchd would restart into a daemon that cannot read the new arguments", installed)
	}
	agent, err := os.ReadFile(paths.LaunchAgentFile)
	if err != nil {
		t.Fatalf("the agent must be written: %v", err)
	}
	if !strings.Contains(string(agent), "<string>"+stableDaemonPath(paths)+"</string>\n\t\t<string>"+daemonModeArg+"</string>") {
		t.Fatalf("the agent does not restart the stable copy in daemon mode:\n%s", agent)
	}
}

func TestLaunchAgentRunsTheBinaryInsideTheBundleSoTheGrantApplies(t *testing.T) {
	dir := t.TempDir()
	paths := Paths{
		StateDir:   filepath.Join(dir, "state"),
		GraphHome:  filepath.Join(dir, "graph-home"),
		SourceRoot: dir,
		DaemonBin:  "/Applications/Graph.app/Contents/MacOS/Graph",
	}
	plist := string(launchAgentPlist(paths, nil))
	want := "<string>" + paths.DaemonBin + "</string>\n\t\t<string>" + daemonModeArg + "</string>"
	if !strings.Contains(plist, want) {
		t.Fatalf("launchd must run the binary inside the bundle in daemon mode, or macOS reads the daemon as its own client and refuses the accessibility grant:\n%s", plist)
	}
	if strings.Contains(plist, stableDaemonPath(paths)) {
		t.Fatal("a copy outside the bundle is a separate accessibility client, so the app's grant never reaches the daemon")
	}
}

func TestDaemonOlderThanItsBinaryIsReportedStale(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "Graph.app", "Contents", "MacOS", "Graph")
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-time.Hour)
	if err := os.Chtimes(binary, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	paths := Paths{StateDir: filepath.Join(dir, "state"), DaemonBin: binary}
	if paths.daemonStale(Console{StartedAt: stamp.Add(time.Minute).UnixMilli()}) {
		t.Fatal("a daemon that started after its binary was written is running the current code")
	}
	if !paths.daemonStale(Console{StartedAt: stamp.Add(-time.Minute).UnixMilli()}) {
		t.Fatal("a daemon that started before its binary was written is running older code and must be restarted")
	}
	if paths.daemonStale(Console{}) {
		t.Fatal("a console record without a start time says nothing about staleness")
	}
}

func TestTheBundleLauncherRemovesTheLeftoverCopy(t *testing.T) {
	dir := t.TempDir()
	paths := Paths{StateDir: filepath.Join(dir, "state"), DaemonBin: "/Applications/Graph.app/Contents/MacOS/Graph"}
	stable := stableDaemonPath(paths)
	if err := os.MkdirAll(filepath.Dir(stable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stable, []byte("older copy"), 0o755); err != nil {
		t.Fatal(err)
	}
	paths.dropStableDaemon()
	if _, err := os.Stat(stable); !os.IsNotExist(err) {
		t.Fatalf("a copy outside the bundle is dead weight and a second accessibility client, so it must go: %v", err)
	}
	paths.dropStableDaemon()
}

func TestLaunchAgentReloadsTheJobWithoutKickstartingItAgain(t *testing.T) {
	paths := Paths{StateDir: "/state", GraphHome: "/home", SourceRoot: "/src", DaemonBin: "/Applications/Graph.app/Contents/MacOS/Graph"}
	for _, reload := range []bool{true, false} {
		plan := launchAgentPlan(paths, reload)
		if len(plan) != 2 {
			t.Fatalf("the job only needs unloading and loading, got %v", plan)
		}
		if strings.Join(plan[0], " ") != "bootout "+launchAgentService() {
			t.Fatalf("the first step unloads the old definition, got %v", plan[0])
		}
		if strings.Join(plan[1], " ") != "bootstrap "+launchAgentDomain()+" "+paths.agentFile() {
			t.Fatalf("the second step loads the plist that is now on disk, got %v", plan[1])
		}
	}
}

func TestLaunchAgentStartUsesRunAtLoadInsteadOfKickstartingAgain(t *testing.T) {
	paths := Paths{StateDir: "/state", GraphHome: "/home", SourceRoot: "/src", DaemonBin: "/Applications/Graph.app/Contents/MacOS/Graph"}
	start := launchAgentPlan(paths, true)
	if len(start) != 2 {
		t.Fatalf("a cold start only needs bootout and bootstrap, got %v", start)
	}
	for _, step := range start {
		if len(step) > 0 && step[0] == "kickstart" {
			t.Fatalf("RunAtLoad already starts the daemon; kickstart -k kills it and launchd throttles the restart for 10s: %v", start)
		}
	}
}

func TestRefreshAsksForAReloadOnlyWhenTheAgentDefinitionChanged(t *testing.T) {
	supervisedPid, ok := launchdChildPid()
	if !ok {
		t.Skip("this machine has no process whose parent is launchd")
	}
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeConsoleForTest(t, stateDir, supervisedPid)
	console := fmt.Sprintf(`{"url":"http://127.0.0.1:1","pid":%d,"mode":"execute","startedAt":%d}`, supervisedPid, time.Now().Add(time.Hour).UnixMilli())
	if err := os.WriteFile(filepath.Join(stateDir, "console.json"), []byte(console), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := Paths{
		StateDir:        stateDir,
		GraphHome:       filepath.Join(dir, "graph-home"),
		SourceRoot:      dir,
		DaemonBin:       "/Applications/Graph.app/Contents/MacOS/Graph",
		LaunchAgentFile: filepath.Join(dir, "dev.graph.daemon.plist"),
	}
	first := newDaemon(paths).refresh()
	if !first.restart || !first.reload {
		t.Fatalf("a job that does not exist yet must be written and booted: %+v", first)
	}
	second := newDaemon(paths).refresh()
	if second.restart || second.reload {
		t.Fatalf("a daemon that runs the current definition needs no restart: %+v", second)
	}
}
