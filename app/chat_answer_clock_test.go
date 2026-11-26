package main

import (
	"testing"
	"time"
)

// TestTheAnswerClockTicksWhileTheAssistantSpeaks is wish 1 for the answer
// itself: while the agent is talking the chat carries a stopwatch that moves
// on its own, and once the answer lands the stopwatch keeps its last reading
// instead of waiting for a poll or a new message.
func TestTheAnswerClockTicksWhileTheAssistantSpeaks(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	tester.Frame()
	now := tester.Now()
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑一下测试", State: "delivered",
			CreatedAt: now.Add(-3 * time.Second).UnixMilli()},
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "正在整理结果", State: "streaming",
			CreatedAt: now.Add(-3 * time.Second).UnixMilli()},
	}
	tester = frames(tester)
	if !tester.HasText("正在回复 · 用时 3s") {
		t.Fatalf("a speaking answer shows its stopwatch, texts %q", tester.Texts())
	}
	tester.Advance(2 * time.Second)
	tester = frames(tester)
	if !tester.HasText("正在回复 · 用时 5s") {
		t.Fatalf("the stopwatch keeps ticking without a new message, texts %q", tester.Texts())
	}
	settled := state.messages[1]
	settled.State = "done"
	settled.Text = "全部通过。"
	state.messages[1] = settled
	tester = frames(tester)
	if !tester.HasText("已用时 5s") {
		t.Fatalf("a settled answer keeps its reading, texts %q", tester.Texts())
	}
	tester.Advance(10 * time.Second)
	tester = frames(tester)
	if tester.HasText("已用时 15s") || tester.HasText("正在回复") {
		t.Fatalf("a settled answer stops counting, texts %q", tester.Texts())
	}
	if !tester.HasText("全部通过。") {
		t.Fatalf("the settled answer still shows, texts %q", tester.Texts())
	}
}

// TestTheAnswerClockFreezesAcrossTheLiveToSettledSwap covers the swap the real
// console makes: the streaming answer arrives as a live entry, then comes back
// from the console under its own message ID once it settles. The reading has to
// survive that change of name, or the stopwatch would vanish at the moment the
// answer lands.
func TestTheAnswerClockFreezesAcrossTheLiveToSettledSwap(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	tester.Frame()
	now := tester.Now()
	user := transcriptMessage{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑一下测试", State: "delivered",
		CreatedAt: now.Add(-3 * time.Second).UnixMilli()}
	state.messages = []transcriptMessage{
		user,
		{ID: "live:op1/e1", Seq: 2, Role: "assistant", Kind: "chat", Text: "正在整理结果", State: "streaming",
			OperationID: "op1", CreatedAt: now.Add(-3 * time.Second).UnixMilli()},
	}
	tester = frames(tester)
	if !tester.HasText("正在回复 · 用时 3s") {
		t.Fatalf("the live answer shows its stopwatch, texts %q", tester.Texts())
	}
	tester.Advance(2 * time.Second)
	tester = frames(tester)
	state.messages = []transcriptMessage{
		user,
		{ID: "a1", Seq: 2, Role: "assistant", Kind: "chat", Text: "全部通过。", State: "done",
			OperationID: "op1", CreatedAt: now.Add(-3 * time.Second).UnixMilli()},
	}
	tester = frames(tester)
	if !tester.HasText("已用时 5s") {
		t.Fatalf("the settled answer keeps the reading from when it was live, texts %q", tester.Texts())
	}
}

// TestAnAnswerFromLongAgoShowsNoStopwatch keeps the chat from turning an old
// timestamp into an invented duration: without a recent start the answer shows
// no clock at all.
func TestAnAnswerFromLongAgoShowsNoStopwatch(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "正在整理结果", State: "streaming", CreatedAt: 1_000_000},
	}
	tester := frames(newTester(state.view, 760, 620))
	if tester.HasText("用时") {
		t.Fatalf("a stale timestamp invents no duration, texts %q", tester.Texts())
	}
}

// TestTheAnswerClockKeepsTickingWhileTheRoundRuns covers the gap the console
// leaves: the answer's own state can lag behind the round, so the stopwatch has
// to keep counting while the master of this round still runs, one second at a
// time, instead of freezing until the next poll flips the state.
func TestTheAnswerClockKeepsTickingWhileTheRoundRuns(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	tester.Frame()
	now := tester.Now()
	state.roundMaster = "running"
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑一下测试", State: "delivered",
			CreatedAt: now.Add(-2 * time.Second).UnixMilli()},
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "正在整理结果", State: "done",
			CreatedAt: now.Add(-2 * time.Second).UnixMilli()},
	}
	tester = frames(tester)
	if !tester.HasText("正在回复 · 用时 2s") {
		t.Fatalf("an answer in a running round shows its stopwatch, texts %q", tester.Texts())
	}
	for _, want := range []string{"正在回复 · 用时 3s", "正在回复 · 用时 4s"} {
		tester.Advance(time.Second)
		tester = frames(tester)
		if !tester.HasText(want) {
			t.Fatalf("the stopwatch counts one second per second, want %q, texts %q", want, tester.Texts())
		}
	}
	state.roundMaster = ""
	tester = frames(tester)
	if !tester.HasText("已用时 4s") {
		t.Fatalf("a landed round freezes the reading, texts %q", tester.Texts())
	}
	tester.Advance(3 * time.Second)
	tester = frames(tester)
	if tester.HasText("已用时 7s") || tester.HasText("正在回复") {
		t.Fatalf("a landed answer stops counting, texts %q", tester.Texts())
	}
}
