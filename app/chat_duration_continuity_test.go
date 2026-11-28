package main

import (
	"testing"
	"time"
)

// A round can hold exactly one tool call, and the record already says when that
// call ended. The run must read that instead of falling back to a call count,
// which is what made the duration appear and disappear between rounds.
func TestASingleToolCallShowsItsMeasuredDuration(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	now := tester.Now()
	call := activityTool("bash", "bash: go test ./...", "done")
	call.CreatedAt = now.Add(-5 * time.Second).UnixMilli()
	call.UpdatedAt = now.Add(-2 * time.Second).UnixMilli()
	state.messages = []transcriptMessage{call}
	tester = frames(tester)
	if !tester.HasText("用时 3s") {
		t.Fatalf("one finished tool call knows how long it took, texts %q", tester.Texts())
	}
	if tester.HasText("1 次工具调用") {
		t.Fatalf("the call count replaced the measured duration, texts %q", tester.Texts())
	}
}

// The console reports how long the answer's operation really ran, measured from
// the first dispatch to the last settlement. A reload must read that number, not
// lose the reading the window never watched.
func TestASettledAnswerKeepsItsMeasuredDurationAfterAReload(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	now := newTester(state.view, 760, 620).Now()
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "跑一下", State: "delivered",
			CreatedAt: now.Add(-10 * time.Second).UnixMilli()},
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "全部通过。", State: "done",
			CreatedAt: now.Add(-9 * time.Second).UnixMilli(), DurationMs: 5_000},
	}
	tester := frames(newTester(state.view, 760, 620))
	if !tester.HasText("已用时 5s") {
		t.Fatalf("a settled answer restored from the console keeps its measured span, texts %q", tester.Texts())
	}
}

// The duration of a run is the whole time its calls took, end of the last call
// included - not the gap between the first and the last start.
func TestAToolRunCountsTheTimeItsLastCallTook(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	now := tester.Now()
	first := activityTool("bash", "bash: echo hi", "done")
	first.CreatedAt = now.Add(-8 * time.Second).UnixMilli()
	first.UpdatedAt = now.Add(-7 * time.Second).UnixMilli()
	last := activityTool("bash", "bash: go test ./...", "done")
	last.CreatedAt = now.Add(-7 * time.Second).UnixMilli()
	last.UpdatedAt = now.Add(-1 * time.Second).UnixMilli()
	state.messages = []transcriptMessage{first, last}
	tester = frames(tester)
	if !tester.HasText("用时 7s") {
		t.Fatalf("the run spans from the first start to the last end, texts %q", tester.Texts())
	}
}
