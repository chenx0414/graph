package graph

import (
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
