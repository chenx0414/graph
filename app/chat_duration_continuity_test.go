package main

import (
	"testing"
	"time"
)

// A one-call run must read its measured end, not fall back to a call count.
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

// A reload must read the operation span the console reports.
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

// A run spans from the first start to the last end, not between starts.
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
