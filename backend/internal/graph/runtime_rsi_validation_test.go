package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The default gate runs once.
//
// A caller that lists `node --run check` as its own check has already asked for
// the whole gate; running it again before activation doubled every commit - the
// measured cost of one apply was two full gates plus the build.
func TestDefaultGateIsNotRepeatedWhenTheChecksAlreadyNameIt(t *testing.T) {
	gate := RsiCommand{Command: "node", Args: []string{"--run", "check"}}
	if rsiNeedsDefaultGate([]RsiCommand{gate}, true) {
		t.Fatal("the gate the checks already ran must not run a second time")
	}
	if !rsiNeedsDefaultGate(nil, true) {
		t.Fatal("a change without checks still needs the default gate before activation")
	}
	if !rsiNeedsDefaultGate([]RsiCommand{{Command: "node", Args: []string{"--run", "check:backend"}}}, true) {
		t.Fatal("a narrower check is not the default gate")
	}
	if !rsiNeedsDefaultGate([]RsiCommand{{Command: "node", Args: []string{"--run", "build:web"}}}, true) {
		t.Fatal("a build is not the default gate")
	}
	// A rehearsal without activation returns after the caller's checks, so the
	// default gate is not owed at all.
	if rsiNeedsDefaultGate([]RsiCommand{gate}, false) || rsiNeedsDefaultGate(nil, false) {
		t.Fatal("without activation no default gate is owed")
	}
}

// The confirmation runs at a lower priority, so a change made right after a
// reload does not queue behind the whole suite.
func TestAsyncFullRunsNice(t *testing.T) {
	command := rsiAsyncFullCommand()
	if command.Command != "node" || strings.Join(command.Args, " ") != "--run check:full" {
		t.Fatalf("the confirmation is still the full suite, got %v %v", command.Command, command.Args)
	}
	if command.Nice != 10 {
		t.Fatalf("the confirmation has to ask for a lower priority, got %d", command.Nice)
	}
}

// A command that never ran has no suite lines to keep, so the summary quotes
// what the command itself said. Measured 2026-11-07: a wrapper that broke node
// produced one line ("bad option: -n") and the wake reported it as a plain
// regression with an empty摘要.
func TestAsyncFullSummaryKeepsTheCommandlineWhenNothingMatches(t *testing.T) {
	output := "/Applications/Graph.app/Contents/Resources/app/runtime/node: bad option: -n"
	summary := rsiAsyncFullSummary(output)
	if !strings.Contains(summary, "bad option: -n") {
		t.Fatalf("the summary has to quote the line the command printed, got %q", summary)
	}
}

func TestAsyncFullSummaryStaysReadableWithoutOutput(t *testing.T) {
	if got := rsiAsyncFullSummary("   \n\n  "); !strings.Contains(got, "没有任何输出") {
		t.Fatalf("an empty log says so, got %q", got)
	}
}

func TestBundledNodeMustExistBeforeItIsUsed(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "runtime", "node")
	env := map[string]string{RUNTIME_NODE_ENV: missing, "PATH": "/usr/bin:/bin"}

	if runtime, _ := GraphNodeRuntime(env); runtime == missing {
		t.Fatalf("a path that does not exist was handed out as the node runtime: %q", runtime)
	}
	plan := ValidationCommand(RsiCommand{Args: []string{"--version"}}, env)
	if plan.Executable == missing {
		t.Fatalf("validation would exec a missing binary: %q", plan.Executable)
	}

	present := filepath.Join(t.TempDir(), "node")
	if err := os.WriteFile(present, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	kept := map[string]string{RUNTIME_NODE_ENV: present, "PATH": "/usr/bin:/bin"}
	if runtime, _ := GraphNodeRuntime(kept); runtime != present {
		t.Fatalf("an existing bundled node was ignored: %q", runtime)
	}
	if plan := ValidationCommand(RsiCommand{Args: []string{"--version"}}, kept); plan.Executable != present {
		t.Fatalf("validation ignored an existing bundled node: %q", plan.Executable)
	}
}

func TestAppChangesRebuildTheShellThatCarriesThem(t *testing.T) {
	for _, path := range []string{
		"app/rsi.go",
		"app/mygo.json",
		"scripts/package-app-mygo.mjs",
		"scripts/install-desktop-app.mjs",
	} {
		if !rsiNeedsAppBuild([]string{path}) {
			t.Fatalf("%s must rebuild the desktop app", path)
		}
	}
	for _, path := range []string{
		"backend/internal/graph/server.go",
		"src/web/main.tsx",
		"README.md",
	} {
		if rsiNeedsAppBuild([]string{path}) {
			t.Fatalf("%s must not rebuild the desktop app", path)
		}
	}
}

func TestExistingNodeRejectsADirectory(t *testing.T) {
	directory := t.TempDir()
	if node := existingNode(directory); node != "" {
		t.Fatalf("a directory was accepted as the node runtime: %q", node)
	}
	if node := existingNode(""); node != "" {
		t.Fatalf("an empty path was accepted: %q", node)
	}
}
