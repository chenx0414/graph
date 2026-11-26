package main

import (
	"testing"
	"time"
)

func TestTheToolRunStopwatchAdvancesWhileActive(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	tester.Frame()
	now := tester.Now()
	running := activityTool("bash", "bash: go test ./...", "running")
	running.CreatedAt = now.Add(-3 * time.Second).UnixMilli()
	state.messages = []transcriptMessage{running}
	tester.Frame()
	if !tester.HasText("用时 3s") {
		t.Fatalf("the running tool shows its first second, texts %q", tester.Texts())
	}
	tester.Advance(time.Second)
	if !tester.HasText("用时 4s") {
		t.Fatalf("the running tool ticks a second later, texts %q", tester.Texts())
	}
	tester.Advance(2 * time.Second)
	if !tester.HasText("用时 6s") {
		t.Fatalf("the running tool keeps ticking without a message, texts %q", tester.Texts())
	}
}

func TestTheToolRunStopwatchStopsWhenTheToolSettles(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	tester.Frame()
	now := tester.Now()
	first := activityTool("bash", "bash: go test ./...", "done")
	first.CreatedAt = now.Add(-5 * time.Second).UnixMilli()
	second := activityTool("bash", "bash: pwd", "done")
	second.CreatedAt = now.Add(-2 * time.Second).UnixMilli()
	state.messages = []transcriptMessage{first, second}
	tester.Frame()
	if !tester.HasText("用时 3s") {
		t.Fatalf("the settled tool run freezes at its span, texts %q", tester.Texts())
	}
	tester.Advance(5 * time.Second)
	tester.Frame()
	if !tester.HasText("用时 3s") {
		t.Fatalf("the settled tool run does not keep counting, texts %q", tester.Texts())
	}
	if tester.HasText("用时 8s") {
		t.Fatalf("the settled tool run read the wall clock, texts %q", tester.Texts())
	}
}

func TestTheAgentCardStopwatchKeepsRunningTimeWhileRunning(t *testing.T) {
	start := int64(1_700_000_000_000)
	now := time.UnixMilli(start + 9_000)
	running := fleetAgent{Status: "running", CreatedAt: start, UpdatedAt: start + 2_000}
	if got := fleetAgentElapsedMs(running, now); got != 9_000 {
		t.Fatalf("a running agent keeps counting to now, got %d", got)
	}
	settled := fleetAgent{Status: "done", CreatedAt: start, UpdatedAt: start + 2_000}
	if got := fleetAgentElapsedMs(settled, now); got != 2_000 {
		t.Fatalf("a settled agent freezes at its span, got %d", got)
	}
}
