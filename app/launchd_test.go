package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStableDaemonInstallKeepsTheBinaryWhenNothingChanged(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "graphd")
	target := filepath.Join(dir, "bin", "graphd")
	if err := os.WriteFile(source, []byte("first build"), 0o755); err != nil {
		t.Fatal(err)
	}
	changed, err := installStableDaemon(source, target)
	if err != nil || !changed {
		t.Fatalf("the first install must write the binary: changed %v err %v", changed, err)
	}
	installed, err := os.ReadFile(target)
	if err != nil || string(installed) != "first build" {
		t.Fatalf("installed %q err %v", installed, err)
	}
	stamp := time.Now().Add(-time.Hour)
	if err := os.Chtimes(target, stamp, stamp); err != nil {
		t.Fatal(err)
	}

	changed, err = installStableDaemon(source, target)
	if err != nil || changed {
		t.Fatalf("an identical build must leave the installed file alone: changed %v err %v", changed, err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.ModTime().After(stamp.Add(time.Minute)) {
		t.Fatal("the installed binary was rewritten although its content did not change: its cdhash would change and the accessibility grant would be lost")
	}

	if err := os.WriteFile(source, []byte("second build"), 0o755); err != nil {
		t.Fatal(err)
	}
	changed, err = installStableDaemon(source, target)
	if err != nil || !changed {
		t.Fatalf("a new build must replace the installed binary: changed %v err %v", changed, err)
	}
	installed, err = os.ReadFile(target)
	if err != nil || string(installed) != "second build" {
		t.Fatalf("installed %q err %v", installed, err)
	}
}

func TestLaunchAgentPlistPinsTheStablePathAndTheDaemonArguments(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "graph.config.json")
	if err := os.WriteFile(configPath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := Paths{
		StateDir:   filepath.Join(dir, "state"),
		GraphHome:  filepath.Join(dir, "graph-home"),
		ConfigPath: configPath,
		SourceRoot: dir,
		DaemonBin:  filepath.Join(dir, "dist", "graphd"),
	}
	stable := stableDaemonPath(paths)
	if !strings.HasSuffix(stable, "/bin/graphd") || strings.Contains(stable, "/dist/") {
		t.Fatalf("the stable binary must live outside any build directory, got %q", stable)
	}
	plist := string(launchAgentPlist(paths, []string{"GRAPH_KEY=secret"}))
	for _, want := range []string{
		"<string>" + launchAgentLabel + "</string>",
		"<string>" + stable + "</string>",
		"<string>--state-dir</string>",
		"<string>" + paths.StateDir + "</string>",
		"<string>--graph-home</string>",
		"<string>--application-root</string>",
		"<string>" + configPath + "</string>",
		"<key>RunAtLoad</key>",
		"<key>GRAPH_KEY</key>",
		"<string>secret</string>",
	} {
		if !strings.Contains(plist, want) {
			t.Fatalf("the plist is missing %q:\n%s", want, plist)
		}
	}
	if strings.Contains(plist, paths.DaemonBin) {
		t.Fatal("the plist must not launch the binary inside a build directory: a rebuild would change its cdhash")
	}
}

func TestSupervisedFromPPID(t *testing.T) {
	for _, test := range []struct {
		name   string
		output string
		want   bool
	}{
		{"launchd is the parent", "    1\n", true},
		{"the shell is the parent", " 4242\n", false},
		{"no answer", "", false},
		{"garbage", "ppid\n", false},
	} {
		if got := supervisedFromPPID(test.output); got != test.want {
			t.Fatalf("%s: supervisedFromPPID(%q) = %v, want %v", test.name, test.output, got, test.want)
		}
	}
}

func TestInstallLaunchAgentReportsWhetherTheAgentChanged(t *testing.T) {
	dir := t.TempDir()
	paths := Paths{StateDir: filepath.Join(dir, "state"), GraphHome: dir, ConfigPath: "", SourceRoot: dir, DaemonBin: filepath.Join(dir, "dist", "graphd")}
	if err := os.MkdirAll(paths.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	changed, err := writeLaunchAgent(launchAgentPathForTest(t, dir), paths)
	if err != nil || !changed {
		t.Fatalf("the first write must report a change: changed %v err %v", changed, err)
	}
	unchanged, err := writeLaunchAgent(launchAgentPathForTest(t, dir), paths)
	if err != nil || unchanged {
		t.Fatalf("an identical agent must not report a change: changed %v err %v", unchanged, err)
	}
}

func launchAgentPathForTest(t *testing.T, dir string) string {
	t.Helper()
	return filepath.Join(dir, "dev.graph.daemon.plist")
}
