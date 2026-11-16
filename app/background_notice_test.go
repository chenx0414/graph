package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestABackgroundToolNoticeIsNotAUserBubble(t *testing.T) {
	chat := &chatState{messages: []transcriptMessage{{
		ID: "m1", Role: "user", Kind: "chat", Text: "bash 已经结束（settled），结果在会话的工具调用里；请读它继续。",
		Data: transcriptMessageData{Source: transcriptMessageSource{Kind: "tool_settled", Tool: "bash"}},
	}}}
	tester := ui.NewTester(chat.view, 900, 700)
	frames(tester)
	if _, ok := tester.Find("后台任务通知"); !ok {
		t.Fatalf("a background notice is shown as its own row, texts %q", tester.Texts())
	}
	if !tester.HasText("bash 已结束") {
		t.Fatalf("the notice shows its summary, texts %q", tester.Texts())
	}
	if tester.HasText("复制") {
		t.Fatalf("a background notice is not a user message with copy actions, texts %q", tester.Texts())
	}
}
