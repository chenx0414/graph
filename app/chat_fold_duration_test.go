package main

import (
	"testing"
	"time"
)

func foldStepTool(at time.Time, text string) transcriptMessage {
	message := activityTool("bash", text, "done")
	message.CreatedAt = at.UnixMilli()
	return message
}

func foldStepThought(id, text string, at time.Time) transcriptMessage {
	return transcriptMessage{ID: id, Role: "assistant", Kind: "chat", Text: text, State: "done", CreatedAt: at.UnixMilli()}
}

func foldFinalAnswer(at time.Time) transcriptMessage {
	return transcriptMessage{ID: "a-final", Role: "assistant", Kind: "chat", Text: "做完了。", State: "done", CreatedAt: at.UnixMilli()}
}

func TestTheFoldedStepsShowTheirTotalDurationWhenCollapsed(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	render(tester)
	now := tester.Now()
	start := now.Add(-14 * time.Second)
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑测试", State: "delivered", CreatedAt: start.UnixMilli()},
		foldStepThought("a0", "先看仓库", start),
		foldStepTool(start.Add(12*time.Second), "bash: go test ./..."),
		foldFinalAnswer(start.Add(14 * time.Second)),
	}
	tester = frames(tester)
	want := "思考与工具调用 · 用时 " + codexWorkedFor(12*time.Second)
	if !tester.HasText(want) {
		t.Fatalf("the collapsed fold shows the span of its steps (%q), texts %q", want, tester.Texts())
	}
	if err := tester.Click(want); err != nil {
		t.Fatalf("open the fold: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText(want) {
		t.Fatalf("the open fold shows the same total duration (%q), texts %q", want, tester.Texts())
	}
	if !tester.HasText("先看仓库") {
		t.Fatalf("the open fold still lists the thought, texts %q", tester.Texts())
	}
	if err := tester.Click(want); err != nil {
		t.Fatalf("fold again: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText(want) {
		t.Fatalf("the re-folded bar keeps the duration (%q), texts %q", want, tester.Texts())
	}
	if tester.HasText("先看仓库") {
		t.Fatalf("folding hides the thought again, texts %q", tester.Texts())
	}
}

func TestStaleFoldStepsShowNoInventedDuration(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑测试", State: "delivered", CreatedAt: 1_000_000},
		foldStepTool(time.UnixMilli(1_000_000), "bash: go test ./..."),
		foldFinalAnswer(time.UnixMilli(1_012_000)),
	}
	tester := frames(newTester(state.view, 760, 620))
	if tester.HasText("用时") {
		t.Fatalf("an old fold invents no duration, texts %q", tester.Texts())
	}
}

func TestFoldedStepsWithNoTimestampsShowNoDuration(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑测试", State: "delivered", CreatedAt: 1_000_000},
		foldStepTool(time.UnixMilli(0), "bash: go test ./..."),
		foldFinalAnswer(time.UnixMilli(1_012_000)),
	}
	tester := frames(newTester(state.view, 760, 620))
	if tester.HasText("用时") {
		t.Fatalf("steps with no timestamps show no duration, texts %q", tester.Texts())
	}
}

func TestFoldDurationFormatsMinutesAndSeconds(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	render(tester)
	now := tester.Now()
	start := now.Add(-3 * time.Minute)
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑测试", State: "delivered", CreatedAt: start.UnixMilli()},
		foldStepThought("a0", "先看仓库", start),
		foldStepTool(start.Add(90*time.Second), "bash: go test ./..."),
		foldFinalAnswer(start.Add(100 * time.Second)),
	}
	tester = frames(tester)
	want := "思考与工具调用 · 用时 " + codexWorkedFor(90*time.Second)
	if !tester.HasText(want) {
		t.Fatalf("the fold duration formats minutes (%q), texts %q", want, tester.Texts())
	}
}
