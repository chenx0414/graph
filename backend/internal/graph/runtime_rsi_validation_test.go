package graph

import (
	"os/exec"
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
	joined := command.Command + " " + strings.Join(command.Args, " ")
	if !strings.Contains(joined, "check:full") {
		t.Fatalf("the confirmation is still the full suite, got %q", joined)
	}
	if _, err := exec.LookPath("nice"); err == nil && !strings.HasPrefix(joined, "nice -n 10 node") {
		t.Fatalf("where nice exists the confirmation runs under it, got %q", joined)
	}
}
