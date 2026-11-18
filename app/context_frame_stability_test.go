package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// scrollingTranscript is a long chat whose rows change height while the user
// scrolls, the way the real transcript does when history pages in and folds
// open and close.
func scrollingTranscript(t *testing.T, shell *shellState) *ui.Tester {
	t.Helper()
	messages := []transcriptMessage{}
	for index := 0; index < 40; index++ {
		role := "user"
		if index%2 == 1 {
			role = "assistant"
		}
		messages = append(messages, transcriptMessage{
			ID:   "m" + itoaSmall(index),
			Seq:  int64(index + 1),
			Role: role,
			Kind: "chat",
			Text: "第 " + itoaSmall(index) + " 条消息",
		})
	}
	shell.chat = newChatState("http://127.0.0.1:1", "tok")
	shell.chat.currentModel = "deepseek/deepseek-v4.1-flash"
	shell.chat.messages = messages
	shell.modelMeta = ambiguousModelMeta()
	shell.trajectory.data = truthTrajectory(120_000, 900_000)
	return ui.NewTester(func(ctx *ui.Context) {
		ui.Row(ctx).Fill().Children(func() {
			ui.Column(ctx).Grow(1).Children(func() {
				scroll := ui.Scroll(ctx).Grow(1)
				scroll.Children(func() {
					ui.Column(ctx).Gap(40).Children(func() {
						for _, message := range messages {
							ui.Box(ctx).FillWidth().Height(30).Label(message.Text)
						}
					})
				})
			})
			ui.Column(ctx).Width(300).Children(func() {
				shell.panelContextOverview(ctx)
			})
		})
	}, 900, 500)
}

func itoaSmall(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

// TestTheContextCardKeepsItsNumbersWhileTheChatScrolls pins the reported
// flicker: scrolling the chat redraws the whole pane, and the context card must
// show exactly the same numbers while the transcript moves.
func TestTheContextCardKeepsItsNumbersWhileTheChatScrolls(t *testing.T) {
	shell := newShellState("http://127.0.0.1:1", "tok")
	tester := frames(scrollingTranscript(t, shell))
	first := textsJoined(tester)
	for step := 0; step < 6; step++ {
		tester.Wheel(200, 250, 0, -120)
		tester.Frame()
		if got := textsJoined(tester); got != first {
			t.Fatalf("scroll step %d changed the context card\nbefore: %q\nafter:  %q", step, first, got)
		}
	}
}
