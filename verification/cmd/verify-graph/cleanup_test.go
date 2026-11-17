package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseElapsedUnderstandsBSDPSShapes(t *testing.T) {
	cases := map[string]time.Duration{
		"00:05":        5 * time.Second,
		"01:02":        62 * time.Second,
		"03:04:05":     3*time.Hour + 4*time.Minute + 5*time.Second,
		"1-02:03:04":   24*time.Hour + 2*time.Hour + 3*time.Minute + 4*time.Second,
		" 2-00:00:00 ": 48 * time.Hour,
	}
	for raw, want := range cases {
		got, ok := parseElapsed(raw)
		if !ok || got != want {
			t.Fatalf("parseElapsed(%q) = %v, %v; want %v", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "junk", "1:2:3:4", "-1:00", "aa:bb"} {
		if _, ok := parseElapsed(raw); ok {
			t.Fatalf("parseElapsed(%q) must fail", raw)
		}
	}
}

func TestRunDirForStateDirStaysInsideTheRunRoot(t *testing.T) {
	root := t.TempDir()
	p := paths{RunRoot: filepath.Join(root, ".run")}
	for stateDir, want := range map[string]string{
		filepath.Join(p.RunRoot, "abcd", "state"):             "abcd",
		filepath.Join(p.RunRoot, "abcd", "instance", "state"): "abcd",
	} {
		dir, ok := runDirForStateDir(p, stateDir)
		if !ok || dir != filepath.Join(p.RunRoot, want) {
			t.Fatalf("runDirForStateDir(%q) = %q, %v; want %q", stateDir, dir, ok, want)
		}
	}
	for _, stateDir := range []string{
		"",
		filepath.Join(p.RunRoot, "bin", "state"),
		filepath.Join(p.RunRoot),
		filepath.Join(root, "elsewhere", "state"),
		"/Users/someone/Library/Application Support/Graph/state",
	} {
		if dir, ok := runDirForStateDir(p, stateDir); ok {
			t.Fatalf("runDirForStateDir(%q) = %q; it must be refused", stateDir, dir)
		}
	}
}

func TestPlanOrphansOnlySelectsOwnedOldDaemons(t *testing.T) {
	root := t.TempDir()
	p := paths{RunRoot: filepath.Join(root, ".run")}
	livePID := os.Getpid()
	runs := []runMeta{{RunID: "live", Daemon: daemonMeta{PID: livePID}}}
	state := func(id string) string { return filepath.Join(p.RunRoot, id, "state") }
	daemons := []daemonProcess{
		{PID: livePID, StateDir: state("live"), Command: "graphd --state-dir " + state("live")},
		{PID: 900001, Start: "s1", StateDir: state("old"), Command: "graphd --state-dir " + state("old")},
		{PID: 900002, StateDir: state("young"), Command: "graphd --state-dir " + state("young")},
		{PID: 900003, StateDir: "/Users/someone/Library/Application Support/Graph/state", Command: "Graph daemon"},
		{PID: 900004, StateDir: state("mismatch"), Command: "graphd --state-dir /somewhere/else"},
		{PID: 900006, StateDir: state("live"), Command: "/bin/sh " + filepath.Join(p.RunRoot, "live", "keeper.sh") + " graphd --state-dir " + state("live")},
		{PID: 1, StateDir: state("one"), Command: "init"},
	}
	ages := map[int]time.Duration{
		livePID: 1 * time.Hour,
		900001:  10 * time.Minute,
		900002:  5 * time.Second,
		900003:  1 * time.Hour,
		900004:  1 * time.Hour,
	}
	targets, skipped := planOrphans(p, runs, daemons, 2*time.Minute, func(pid int) (time.Duration, bool) {
		age, ok := ages[pid]
		return age, ok
	})
	if len(targets) != 1 || targets[0].PID != 900001 || targets[0].AgeSecs != 600 {
		t.Fatalf("targets = %+v; only the old owned daemon may be selected", targets)
	}
	if len(skipped) != 5 {
		t.Fatalf("skipped = %+v; the live, young, foreign, mismatched and keeper processes must be explained", skipped)
	}
	reasons := ""
	for _, skip := range skipped {
		reasons += skip.Reason + "\n"
	}
	for _, want := range []string{"live run", "younger", "not inside", "does not name"} {
		if !contains(reasons, want) {
			t.Fatalf("a skip reason must mention %q:\n%s", want, reasons)
		}
	}
}

func TestPlanningRefusesAnOrphanWhoseAgeIsUnknown(t *testing.T) {
	p := paths{RunRoot: filepath.Join(t.TempDir(), ".run")}
	stateDir := filepath.Join(p.RunRoot, "abcd", "state")
	targets, skipped := planOrphans(p, nil,
		[]daemonProcess{{PID: 900005, StateDir: stateDir, Command: "graphd --state-dir " + stateDir}},
		time.Minute, func(int) (time.Duration, bool) { return 0, false })
	if len(targets) != 0 || len(skipped) != 1 || !contains(skipped[0].Reason, "unknown") {
		t.Fatalf("unknown age must be skipped, got targets=%+v skipped=%+v", targets, skipped)
	}
}

func TestRemoveRunDirRemovesTheWholeRunButRefusesEscapes(t *testing.T) {
	root := t.TempDir()
	p := paths{RunRoot: filepath.Join(root, ".run")}
	runDir := filepath.Join(p.RunRoot, "abcd")
	if err := os.MkdirAll(filepath.Join(runDir, "instance", "state"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runDir, "instance", "leftover.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removeRunDir(p, "abcd"); err != nil {
		t.Fatalf("removeRunDir: %v", err)
	}
	if _, err := os.Stat(runDir); !os.IsNotExist(err) {
		t.Fatalf("the whole run directory must be gone, stat err = %v", err)
	}
	for _, runID := range []string{"", ".", "..", "../escape", "bin", "a/b"} {
		if err := removeRunDir(p, runID); err == nil {
			t.Fatalf("removeRunDir(%q) must be refused", runID)
		}
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || len(needle) == 0 ||
		indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}
