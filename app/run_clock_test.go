package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func runClockTool(name, text, state string, at time.Time) transcriptMessage {
	message := activityTool(name, text, state)
	message.CreatedAt = at.UnixMilli()
	return message
}

func TestTheRunningDurationGrowsLikeAStopwatchWhileTheRunIsActive(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := ui.NewTester(state.view, 760, 620)
	now := tester.Now()
	state.messages = []transcriptMessage{
		runClockTool("bash", "bash: echo hi", "done", now.Add(-2*time.Second)),
		runClockTool("bash", "bash: go test ./...", "running", now.Add(-2*time.Second)),
	}
	frames(tester)
	if !tester.HasText("用时 2s") {
		t.Fatalf("a running run shows its elapsed time, texts %q", tester.Texts())
	}
	tester.Advance(3 * time.Second)
	if !tester.HasText("用时 5s") {
		t.Fatalf("the stopwatch moved on its own after three seconds, texts %q", tester.Texts())
	}
	tester.Advance(2 * time.Second)
	if !tester.HasText("用时 7s") {
		t.Fatalf("the stopwatch keeps counting, texts %q", tester.Texts())
	}
}

func TestTheRunningDurationStopsWhenTheRunSettles(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := ui.NewTester(state.view, 760, 620)
	now := tester.Now()
	state.messages = []transcriptMessage{
		runClockTool("bash", "bash: echo hi", "done", now.Add(-6*time.Second)),
		runClockTool("bash", "bash: go test ./...", "done", now.Add(-1*time.Second)),
	}
	frames(tester)
	if !tester.HasText("用时 5s") {
		t.Fatalf("a settled run shows how long it took, texts %q", tester.Texts())
	}
	tester.Advance(5 * time.Second)
	if !tester.HasText("用时 5s") {
		t.Fatalf("a settled run stops counting, texts %q", tester.Texts())
	}
}

func TestTheRunningDurationNeverRunsBackwardsWhenNewWorkArrives(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := ui.NewTester(state.view, 760, 620)
	now := tester.Now()
	first := runClockTool("bash", "bash: echo hi", "running", now.Add(-4*time.Second))
	first.Data.ToolCallID = "call-a"
	state.messages = []transcriptMessage{first}
	frames(tester)
	if !tester.HasText("用时 4s") {
		t.Fatalf("the stopwatch starts where the run started, texts %q", tester.Texts())
	}
	second := runClockTool("bash", "bash: go test ./...", "running", now.Add(-1*time.Second))
	second.Data.ToolCallID = "call-b"
	state.messages = []transcriptMessage{first, second}
	frames(tester)
	if !tester.HasText("用时 4s") {
		t.Fatalf("a new tool in the same run keeps the stopwatch where it was, texts %q", tester.Texts())
	}
}

func TestTheAgentCardElapsedTimeCountsWhileTheAgentRuns(t *testing.T) {
	start := time.UnixMilli(1_700_000_000_000)
	running := fleetAgent{Status: "running", CreatedAt: start.UnixMilli(), UpdatedAt: start.Add(2 * time.Second).UnixMilli()}
	if got := fleetAgentElapsedMs(running, start.Add(9*time.Second)); got != 9_000 {
		t.Fatalf("a running agent counts to now, got %d", got)
	}
	settled := fleetAgent{Status: "done", CreatedAt: start.UnixMilli(), UpdatedAt: start.Add(2 * time.Second).UnixMilli()}
	if got := fleetAgentElapsedMs(settled, start.Add(9*time.Second)); got != 2_000 {
		t.Fatalf("a settled agent freezes at its span, got %d", got)
	}
}
