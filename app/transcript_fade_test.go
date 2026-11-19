package main

import (
	"fmt"
	"testing"

	"github.com/egoist/mygo/ui"
)

func transcriptFadeShell(t *testing.T) *shellState {
	t.Helper()
	state := fourPaneShell(t)
	chat := state.chat
	if chat == nil {
		t.Fatal("the shell must carry a chat")
	}
	chat.messages = nil
	for index := 0; index < 60; index++ {
		chat.messages = append(chat.messages, transcriptMessage{
			ID:        fmt.Sprintf("m%02d", index),
			Seq:       int64(index + 1),
			Role:      "assistant",
			Kind:      "chat",
			Text:      fmt.Sprintf("历史消息 %02d", index),
			State:     "done",
			CreatedAt: 1700000000000,
		})
	}
	chat.status = ""
	chat.loading = false
	return state
}

func TestTheChatTranscriptStartsAtItsDividerWithoutABlankBand(t *testing.T) {
	state := transcriptFadeShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	chat := state.chat
	if first, last := chat.list.Visible(); last < 0 {
		t.Fatalf("the transcript never rendered its rows, first %d last %d", first, last)
	}
	first, ok := tester.Find("历史消息 00")
	if !ok {
		t.Skip("the oldest row is scrolled out of view at this window size")
	}
	if first.Y < 0 {
		t.Fatalf("the first row sits above the transcript, got %.1f", first.Y)
	}
	top, bottom := (*edgeScroll)(nil).insets()
	if top != 0 || bottom != 0 {
		t.Fatalf("a transcript without a tracked scroll keeps its rows at the edges, got %.1f and %.1f", top, bottom)
	}
}
