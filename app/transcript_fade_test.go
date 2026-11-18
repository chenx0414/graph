package main

import (
	"fmt"
	"math"
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

func TestTheChatTranscriptClearsItsFirstRowFromTheTopFade(t *testing.T) {
	state := transcriptFadeShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	chat := state.chat
	if chat.listScroll.MaxY < 200 {
		t.Fatalf("the transcript must scroll for this assertion, maxY %.1f", chat.listScroll.MaxY)
	}
	chat.listScroll.Y = 0
	tester = frames(tester)
	first, ok := tester.Find("历史消息 00")
	if !ok {
		t.Fatalf("the oldest message never rendered, texts %q", tester.Texts())
	}
	if first.Y < 0 {
		t.Fatalf("the first row sits above the transcript, got %.1f", first.Y)
	}
	top, bottom := fadeInsets(&chat.listScroll)
	if top != fadeEdgeClearance {
		t.Fatalf("a transcript resting at its top clears the top fade by %.1f, got %.1f", fadeEdgeClearance, top)
	}
	if bottom != 0 {
		t.Fatalf("a transcript away from its end adds no bottom clearance, got %.1f", bottom)
	}
}

func TestTheChatTranscriptClearsItsLastRowFromTheBottomFade(t *testing.T) {
	state := transcriptFadeShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	chat := state.chat
	chat.listScroll.Y = math.MaxFloat32
	tester = frames(tester)
	top, bottom := fadeInsets(&chat.listScroll)
	if bottom != fadeEdgeClearance {
		t.Fatalf("a transcript resting at its end clears the bottom fade by %.1f, got %.1f", fadeEdgeClearance, bottom)
	}
	if top != 0 {
		t.Fatalf("a transcript away from its top adds no top clearance, got %.1f", top)
	}
	chat.listScroll.Y = chat.listScroll.MaxY / 2
	frames(tester)
	top, bottom = fadeInsets(&chat.listScroll)
	if top != 0 || bottom != 0 {
		t.Fatalf("a transcript between both ends adds no clearance, got %.1f and %.1f", top, bottom)
	}
}
