package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// mainAgentWindow is a main agent conversation with the round a real one has:
// what the user said, a tool run that is still going, an answer that is still
// being written, and a notice the project supervisor sent the main agent.
func mainAgentWindow(tester *ui.Tester, state *chatState, now time.Time) {
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我看一下进度", State: "delivered",
			CreatedAt: now.Add(-4 * time.Second).UnixMilli()},
		supervisorNotice(supervisorNoticeText),
	}
	first := activityTool("bash", "bash: ls", "done")
	first.ID, first.Data.ToolCallID = "t1", "call-1"
	first.CreatedAt = now.Add(-3 * time.Second).UnixMilli()
	second := activityTool("bash", "bash: go test ./...", "running")
	second.ID, second.Data.ToolCallID = "t2", "call-2"
	second.CreatedAt = now.Add(-2 * time.Second).UnixMilli()
	state.messages = append(state.messages, first, second)
	state.messages = append(state.messages, transcriptMessage{
		ID: "a1", Role: "assistant", Kind: "chat", Text: "正在整理结果", State: "streaming",
		CreatedAt: now.Add(-2 * time.Second).UnixMilli(),
	})
}

// TestTheMainAgentWindowCountsKeepsAgentTalkAsideAndFoldsTheSteps walks one main
// agent conversation through the three wishes that share its transcript: the
// stopwatch on the answer and on the tool run (#1), the collaboration card that
// keeps the supervisor out of the chat flow (#3), and the fold above the final
// answer (#7). It is the acceptance walk-through, not a unit test of each part.
func TestTheMainAgentWindowCountsKeepsAgentTalkAsideAndFoldsTheSteps(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := newTester(state.view, 760, 620)
	tester.Frame()
	now := tester.Now()
	mainAgentWindow(tester, state, now)
	tester = frames(tester)
	if tester.HasText("跨 Agent 协作") {
		t.Fatalf("the chat window keeps no collaboration card, texts %q", tester.Texts())
	}
	if tester.HasText("子 Agent 已完成侦察") {
		t.Fatalf("the supervisor talk stays out of the chat flow, texts %q", tester.Texts())
	}
	if !tester.HasText("正在回复 · 用时 2s") {
		t.Fatalf("the speaking answer counts, texts %q", tester.Texts())
	}
	if !tester.HasText("用时 3s") {
		t.Fatalf("the running tool run counts, texts %q", tester.Texts())
	}
	tester.Advance(2 * time.Second)
	tester = frames(tester)
	if !tester.HasText("正在回复 · 用时 4s") {
		t.Fatalf("the answer stopwatch ticks on its own, texts %q", tester.Texts())
	}
	if !tester.HasText("用时 5s") {
		t.Fatalf("the tool stopwatch ticks on its own, texts %q", tester.Texts())
	}
	answer := state.messages[len(state.messages)-1]
	answer.State, answer.Text = "done", "侦察已经完成。"
	state.messages[len(state.messages)-1] = answer
	last := state.messages[len(state.messages)-2]
	last.State, last.CreatedAt = "done", now.Add(time.Second).UnixMilli()
	state.messages[len(state.messages)-2] = last
	tester = frames(tester)
	if !tester.HasText("已用时 4s") {
		t.Fatalf("the answer keeps its reading once it lands, texts %q", tester.Texts())
	}
	if !tester.HasText("思考与工具调用") {
		t.Fatalf("the steps fold above the final answer, texts %q", tester.Texts())
	}
	if exactText(tester.Texts(), "2 次工具调用") || exactText(tester.Texts(), "用时 4s") {
		t.Fatalf("the folded steps start collapsed, texts %q", tester.Texts())
	}
	if !tester.HasText("侦察已经完成。") || !tester.HasText("帮我看一下进度") {
		t.Fatalf("the conversation keeps what the user and the agent said, texts %q", tester.Texts())
	}
	tester.Advance(10 * time.Second)
	tester = frames(tester)
	if tester.HasText("已用时 14s") || tester.HasText("正在回复") {
		t.Fatalf("the answered round stops counting, texts %q", tester.Texts())
	}
	if err := tester.Click("思考与工具调用"); err != nil {
		t.Fatalf("open the fold: %v", err)
	}
	tester = frames(tester)
	if !exactText(tester.Texts(), "用时 4s") {
		t.Fatalf("opening the fold lists the tool run with its frozen duration, texts %q", tester.Texts())
	}
}

// TestTheMainAgentModelPickerMarksEveryProvider is wish 4 in the same window: the
// composer's model picker shows the provider's brand icon where Magpie has one,
// and falls back to a letter tile where it does not.
func TestTheMainAgentModelPickerMarksEveryProvider(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "你好", State: "delivered", CreatedAt: 1_000_000},
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "你好，我在。", State: "done", CreatedAt: 1_005_000},
	}
	state.models = []modelChoice{
		{id: "codex:gpt-5", provider: "codex", available: []string{"high"}},
		{id: "deepseek/deepseek-v4.1-flash", provider: "deepseek"},
		{id: "zeta:house-model", provider: "zeta"},
	}
	state.currentModel = "codex:gpt-5"
	state.modelPicker.open = true
	tester := frames(newTester(state.view, 900, 700))
	texts := tester.Texts()
	for _, letter := range []string{"C", "D"} {
		if exactText(texts, letter) {
			t.Fatalf("provider %q has a brand icon, its letter tile goes away, texts %q", letter, texts)
		}
	}
	if !exactText(texts, "Z") {
		t.Fatalf("a provider without a brand icon keeps its letter tile, texts %q", texts)
	}
	if !tester.HasText("gpt-5") || !tester.HasText("deepseek-v4.1-flash") || !tester.HasText("house-model") {
		t.Fatalf("the picker still lists the models, texts %q", texts)
	}
}
