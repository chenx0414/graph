package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestTheRunClockKeepsTickingWhileToolsRun(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	first := activityTool("bash", "bash: echo hi", "done")
	running := activityTool("bash", "bash: go test ./...", "running")
	running.Data.ToolCallID = "call-live"
	first.Data.ToolCallID = "call-first"
	state.messages = []transcriptMessage{first, running}
	tester := ui.NewTester(state.view, 760, 620)
	tester.Frame()
	start := tester.Now()
	state.messages[0].CreatedAt = start.Add(-time.Second).UnixMilli()
	state.messages[1].CreatedAt = start.Add(-time.Second).UnixMilli()
	tester = frames(tester)
	if !tester.HasText("用时 1s") {
		t.Fatalf("the running tools show a clock, texts %q", tester.Texts())
	}
	tester.Advance(3 * time.Second)
	if !tester.HasText("用时 4s") {
		t.Fatalf("the clock grows without a new message, texts %q", tester.Texts())
	}
	tester.Advance(2 * time.Second)
	if !tester.HasText("用时 6s") {
		t.Fatalf("the clock keeps growing while the tools run, texts %q", tester.Texts())
	}
	settled := state.messages[1]
	settled.State = "done"
	settled.CreatedAt = start.Add(3 * time.Second).UnixMilli()
	state.messages[1] = settled
	tester = frames(tester)
	if !tester.HasText("用时 4s") {
		t.Fatalf("the settled run keeps its final duration, texts %q", tester.Texts())
	}
	tester.Advance(10 * time.Second)
	if !tester.HasText("用时 4s") {
		t.Fatalf("a settled run does not keep counting, texts %q", tester.Texts())
	}
}
