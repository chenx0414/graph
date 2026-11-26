package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// The agent cards count their running time the way the chat rows do: a
// stopwatch that moves on its own while the agent works and freezes when it
// settles, instead of a number that only changes when a poll brings new data.
func TestTheAgentCardClockKeepsCountingWhileTheAgentRuns(t *testing.T) {
	shell := newShellState("http://127.0.0.1:1", "tok")
	shown := fleetAgent{ID: "a1", Name: "worker", Status: "running"}
	tester := newTester(func(ctx *ui.Context) {
		shell.fleetAgentCard(ctx, shown, 220, 120)
	}, 280, 160)
	tester.Frame()
	now := tester.Now()
	shown.CreatedAt = now.Add(-3 * time.Second).UnixMilli()
	shown.UpdatedAt = shown.CreatedAt
	tester = frames(tester)
	if !tester.HasText("3.0s") {
		t.Fatalf("the running agent shows its elapsed time, texts %q", tester.Texts())
	}
	tester.Advance(2 * time.Second)
	if !tester.HasText("5.0s") {
		t.Fatalf("the agent card counts on its own, texts %q", tester.Texts())
	}
	tester.Advance(4 * time.Second)
	if !tester.HasText("9.0s") {
		t.Fatalf("the agent card keeps counting, texts %q", tester.Texts())
	}
	shown.Status = "done"
	shown.UpdatedAt = shown.CreatedAt + 7000
	tester = frames(tester)
	if !tester.HasText("7.0s") {
		t.Fatalf("the settled agent freezes at its span, texts %q", tester.Texts())
	}
	tester.Advance(10 * time.Second)
	if !tester.HasText("7.0s") || tester.HasText("17.0s") {
		t.Fatalf("a settled agent does not keep counting, texts %q", tester.Texts())
	}
}
