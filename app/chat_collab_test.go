package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func supervisorNotice(text string) transcriptMessage {
	message := transcriptMessage{ID: "n1", Role: "user", Kind: "chat", Text: text, State: "done", CreatedAt: 1_000_000}
	message.Data.Source = transcriptMessageSource{Kind: "agent", ConversationID: "p1", TaskID: "t1", Summary: "update"}
	return message
}

const supervisorNoticeText = "[来自项目主管的通知]\n项目: p1\n工作: w1\n里程碑: update\n内容: 子 Agent 已完成侦察\n这条通知不需要回答。"

func TestAgentMessagesStayOutOfTheChatFlow(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我看一下进度", State: "delivered", CreatedAt: 900_000},
		supervisorNotice(supervisorNoticeText),
		{ID: "a1", Role: "assistant", Kind: "chat", Text: "侦察已经完成。", State: "done", CreatedAt: 1_010_000},
	}
	tester := frames(ui.NewTester(state.view, 760, 620))
	if !tester.HasText("帮我看一下进度") {
		t.Fatalf("the user message stays in the chat, texts %q", tester.Texts())
	}
	if !tester.HasText("侦察已经完成。") {
		t.Fatalf("the final answer stays in the chat, texts %q", tester.Texts())
	}
	for _, leaked := range []string{"来自项目主管的通知", "子 Agent 已完成侦察"} {
		if tester.HasText(leaked) {
			t.Fatalf("an agent message leaked into the chat flow as %q, texts %q", leaked, tester.Texts())
		}
	}
	if tester.HasText("跨 Agent 协作") {
		t.Fatalf("the chat window keeps no collaboration card, texts %q", tester.Texts())
	}
}

func TestAnAgentMessageNeverCountsAsTheFinalAnswer(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "u1", Role: "user", Kind: "chat", Text: "帮我跑一下测试", State: "delivered", CreatedAt: 900_000},
		stepToolMessage("t1", "call-1", "bash: go test ./...", "done"),
		supervisorNotice(supervisorNoticeText),
	}
	spoken, collab := splitCollabMessages(state.messages)
	if len(collab) != 1 || len(spoken) != 2 {
		t.Fatalf("the agent message leaves the chat flow, spoken %d collab %d", len(spoken), len(collab))
	}
	tester := frames(ui.NewTester(state.view, 760, 620))
	if !tester.HasText("1 次工具调用") {
		t.Fatalf("a trailing agent message keeps the tool run unfurled, texts %q", tester.Texts())
	}
}

func TestAChatWithOnlyAgentMessagesPointsAtTheFleetTab(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{supervisorNotice(supervisorNoticeText)}
	tester := frames(ui.NewTester(state.view, 760, 620))
	if tester.HasText("跨 Agent 协作") {
		t.Fatalf("the chat window keeps no collaboration card, texts %q", tester.Texts())
	}
	if !tester.HasText("还没有对话") {
		t.Fatalf("the chat says it is empty, texts %q", tester.Texts())
	}
	if tester.HasText("来自项目主管的通知") {
		t.Fatalf("the agent message is not played back as a user bubble, texts %q", tester.Texts())
	}
}
