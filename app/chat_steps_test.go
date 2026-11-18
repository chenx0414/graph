package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func stepToolMessage(id, callID, text, state string) transcriptMessage {
	message := activityTool("bash", text, state)
	message.ID = id
	message.Data.ToolCallID = callID
	message.CreatedAt = 1_000_000
	return message
}

func TestTheFinalAnswerFoldsTheStepsThatCameBeforeIt(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑一下测试", State: "delivered", CreatedAt: 1_000_000},
		stepToolMessage("t1", "call-1", "bash: go test ./...", "done"),
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "做完了，全部通过。", State: "done", CreatedAt: 1_010_000},
	}
	tester := frames(ui.NewTester(state.view, 760, 620))
	if !tester.HasText("做完了，全部通过。") {
		t.Fatalf("the final answer stays in the chat, texts %q", tester.Texts())
	}
	if !tester.HasText("思考与工具调用") {
		t.Fatalf("the steps fold above the final answer, texts %q", tester.Texts())
	}
	if tester.HasText("1 次工具调用") {
		t.Fatalf("the folded steps start collapsed, texts %q", tester.Texts())
	}
	if err := tester.Click("思考与工具调用"); err != nil {
		t.Fatalf("open the folded steps: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("1 次工具调用") {
		t.Fatalf("opening the fold lists the tool run, texts %q", tester.Texts())
	}
	if !tester.HasText("思考与工具调用") {
		t.Fatalf("the fold header stays while open, texts %q", tester.Texts())
	}
	if err := tester.Click("思考与工具调用"); err != nil {
		t.Fatalf("fold the steps again: %v", err)
	}
	tester = frames(tester)
	if tester.HasText("1 次工具调用") {
		t.Fatalf("closing the fold hides the tool run again, texts %q", tester.Texts())
	}
}

func TestARunningAnswerKeepsItsStepsOpen(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑一下测试", State: "delivered", CreatedAt: 1_000_000},
		stepToolMessage("t1", "call-1", "bash: go test ./...", "done"),
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "正在整理结果", State: "streaming", CreatedAt: 1_010_000},
	}
	tester := frames(ui.NewTester(state.view, 760, 620))
	if tester.HasText("思考与工具调用") {
		t.Fatalf("a running answer folds nothing yet, texts %q", tester.Texts())
	}
	if !tester.HasText("1 次工具调用") {
		t.Fatalf("the running round shows its tool run, texts %q", tester.Texts())
	}
}

func TestAnAnswerWithoutStepsHasNoFoldBar(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "你好", State: "delivered", CreatedAt: 1_000_000},
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "你好，我在。", State: "done", CreatedAt: 1_005_000},
	}
	tester := frames(ui.NewTester(state.view, 760, 620))
	if !tester.HasText("你好，我在。") {
		t.Fatalf("the answer shows, texts %q", tester.Texts())
	}
	if tester.HasText("思考与工具调用") {
		t.Fatalf("an answer without steps has no fold bar, texts %q", tester.Texts())
	}
}

func TestTheFoldKeepsTheInterimThoughtsToo(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "查一下问题", State: "delivered", CreatedAt: 1_000_000},
		{ID: "a0", Role: "assistant", Kind: "chat", Text: "先看看仓库结构。", State: "done", CreatedAt: 1_002_000},
		stepToolMessage("t1", "call-1", "bash: ls", "done"),
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "问题在配置里。", State: "done", CreatedAt: 1_010_000},
	}
	tester := frames(ui.NewTester(state.view, 760, 620))
	if !tester.HasText("问题在配置里。") {
		t.Fatalf("the final answer shows, texts %q", tester.Texts())
	}
	if tester.HasText("先看看仓库结构。") {
		t.Fatalf("the interim thought folds away, texts %q", tester.Texts())
	}
	if err := tester.Click("思考与工具调用"); err != nil {
		t.Fatalf("open the folded steps: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("先看看仓库结构。") {
		t.Fatalf("opening the fold brings the interim thought back, texts %q", tester.Texts())
	}
	if !tester.HasText("1 次工具调用") {
		t.Fatalf("opening the fold brings the tool run back, texts %q", tester.Texts())
	}
}
