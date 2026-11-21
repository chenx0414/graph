package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The default gate runs once.
//
// A caller that lists `go -C backend run ./cmd/graphcheck all` as its own check has already asked for
// the whole gate; running it again before activation doubled every commit - the
// measured cost of one apply was two full gates plus the build.
func TestDefaultGateIsNotRepeatedWhenTheChecksAlreadyNameIt(t *testing.T) {
	gate := rsiActivationGate()
	if rsiNeedsDefaultGate([]RsiCommand{gate}, true) {
		t.Fatal("the gate the checks already ran must not run a second time")
	}
	if !rsiNeedsDefaultGate(nil, true) {
		t.Fatal("a change without checks still needs the default gate before activation")
	}
	if !rsiNeedsDefaultGate([]RsiCommand{{Command: "go", Args: []string{"-C", "backend", "test", "./internal/gate"}}}, true) {
		t.Fatal("a narrower check is not the default gate")
	}
	if !rsiNeedsDefaultGate([]RsiCommand{rsiAppBuildCommand()}, true) {
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
//
// The confirmation is a Go command: ValidationCommand keeps the executable the
// caller named, so the suite no longer has to disguise itself as a node script.
func TestAsyncFullRunsNice(t *testing.T) {
	command := rsiAsyncFullCommand()
	if command.Command != "go" || strings.Join(command.Args, " ") != "-C backend run ./cmd/graphcheck all" {
		t.Fatalf("the confirmation is still the full Go suite, got %v %v", command.Command, command.Args)
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
		"backend/internal/appinstall/sign.go",
		"backend/cmd/graphbuild/main.go",
	} {
		if !rsiNeedsAppBuild([]string{path}) {
			t.Fatalf("%s must rebuild the desktop app", path)
		}
	}
	// The window and the daemon are one binary built from backend/ and app/, and
	// the daemon runs out of the installed bundle: a backend change that does not
	// reinstall leaves the running process on the previous code, which reads as
	// "activated" while the fix is not live.
	for _, path := range []string{
		"backend/internal/graph/server.go",
		"backend/internal/pigkernel/session.go",
		"backend/go.mod",
	} {
		if !rsiNeedsAppBuild([]string{path}) {
			t.Fatalf("%s must reinstall the app that carries it", path)
		}
	}
	for _, path := range []string{
		"FEATURE_MAP.md",
		"README.md",
	} {
		if rsiNeedsAppBuild([]string{path}) {
			t.Fatalf("%s must not rebuild the desktop app", path)
		}
	}
}

func TestAppBuildRunsTheGoBuilder(t *testing.T) {
	command := rsiAppBuildCommand()
	if command.Command != "go" || strings.Join(command.Args, " ") != "-C backend run ./cmd/graphbuild app" {
		t.Fatalf("the app build runs %s %v, want the Go packager", command.Command, command.Args)
	}
}

// A check names the program it wants to run. The host used to hand every check
// to node, so a `go ...` check reached node as `node -C backend ...` and died on
// MODULE_NOT_FOUND before it ran anything.
func TestValidationCommandRunsTheNamedProgram(t *testing.T) {
	plan := ValidationCommand(RsiCommand{Command: "go", Args: []string{"-C", "backend", "test", "./..."}}, map[string]string{"PATH": os.Getenv("PATH")})
	if !strings.HasSuffix(plan.Executable, "go") || strings.Contains(plan.Executable, "node") {
		t.Fatalf("a go check resolved to %q", plan.Executable)
	}
	if strings.Join(plan.Args, " ") != "-C backend test ./..." {
		t.Fatalf("the arguments changed: %v", plan.Args)
	}
	nodePlan := ValidationCommand(RsiCommand{Command: "node", Args: []string{"--run", "check"}}, map[string]string{"PATH": os.Getenv("PATH")})
	if !strings.Contains(filepath.Base(nodePlan.Executable), "node") {
		t.Fatalf("a node check resolved to %q", nodePlan.Executable)
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

func TestRSIAcceptsNativeVerificationCommands(t *testing.T) {
	checks := rsiNormalizeChecks([]any{
		map[string]any{"command": "go", "args": []any{"-C", "backend", "test", "./internal/graph", "-run", "TestVerification"}},
		map[string]any{"command": "python3", "args": []any{"scripts/check-queue.py"}},
	}, true)
	if len(checks) != 2 || checks[0].Command != "go" || checks[1].Command != "python3" {
		t.Fatalf("each verification step must execute the requested program: %+v", checks)
	}
	if rsiNeedsDefaultGate(checks, true) {
		t.Fatal("the listed activation gate should run once")
	}
}

// The activation gate has exactly one spelling: python3 scripts/check-queue.py.
// The old `node --run check` spelling survived only as a forwarded launcher in
// package.json, and the repository is deleting that file, so a caller that names the
// dead spelling is not naming this gate and must not suppress it.
func TestTheActivationGateHasOneSpelling(t *testing.T) {
	gate := rsiActivationGate()
	if gate.Command != "python3" || strings.Join(gate.Args, " ") != "scripts/check-queue.py" {
		t.Fatalf("the activation gate is %s %v, want python3 scripts/check-queue.py", gate.Command, gate.Args)
	}
	if rsiNeedsDefaultGate([]RsiCommand{gate}, true) {
		t.Fatal("a caller that already ran the gate must not run it twice")
	}
	for _, dead := range []RsiCommand{
		{Command: "node", Args: []string{"--run", "check"}},
		{Command: "npm", Args: []string{"run", "check"}},
	} {
		if !rsiNeedsDefaultGate([]RsiCommand{dead}, true) {
			t.Fatalf("%s %v is not this gate, so the default gate is still owed", dead.Command, dead.Args)
		}
	}
}
