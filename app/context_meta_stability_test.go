package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// ambiguousModelMeta is the real shape of this machine's model list: several
// providers expose a model with the same leaf name and different windows.
func ambiguousModelMeta() map[string]modelMeta {
	return map[string]modelMeta{
		"opencode-go:deepseek-v4.1-flash":                                {id: "opencode-go:deepseek-v4.1-flash", modelID: "deepseek-v4.1-flash", contextWindow: 1_000_000},
		"command-goat:deepseek/deepseek-v4.1-flash":                      {id: "command-goat:deepseek/deepseek-v4.1-flash", modelID: "deepseek/deepseek-v4.1-flash", contextWindow: 262_144},
		"commandcode-plan:commandcode-plan/deepseek/deepseek-v4.1-flash": {id: "commandcode-plan:commandcode-plan/deepseek/deepseek-v4.1-flash", modelID: "commandcode-plan/deepseek/deepseek-v4.1-flash", contextWindow: 131_072},
	}
}

// TestTheContextWindowForAModelDoesNotChangeBetweenFrames pins the flicker: the
// card resolves the model's window on every frame, and the lookup walked a map,
// so the same model could report a different window (and so a different
// percentage and bar) on the next frame, which is visible as flicker.
func TestTheContextWindowForAModelDoesNotChangeBetweenFrames(t *testing.T) {
	shell := newShellState("http://127.0.0.1:1", "tok")
	shell.modelMeta = ambiguousModelMeta()
	const model = "deepseek/deepseek-v4.1-flash"
	windows := map[int64]bool{}
	for attempt := 0; attempt < 50; attempt++ {
		meta, _ := shell.modelMetaFor(model)
		windows[meta.contextWindow] = true
	}
	if len(windows) != 1 {
		t.Fatalf("the same model resolves to %d different windows: %v", len(windows), windows)
	}
}

// TestTheContextCardKeepsItsNumbersWhileScrolling pins the symptom the user saw:
// frames drawn while the chat list scrolls must show the same context numbers.
func TestTheContextCardKeepsItsNumbersWhileScrolling(t *testing.T) {
	shell := newShellState("http://127.0.0.1:1", "tok")
	shell.chat = newChatState("http://127.0.0.1:1", "tok")
	shell.chat.currentModel = "deepseek/deepseek-v4.1-flash"
	shell.modelMeta = ambiguousModelMeta()
	shell.trajectory.data = truthTrajectory(120_000, 900_000)
	tester := frames(newTester(func(ctx *ui.Context) {
		ui.Box(ctx).FillWidth().Height(320).Children(func() {
			shell.panelContextOverview(ctx)
		})
	}, 760, 320))
	first := textsJoined(tester)
	for frame := 0; frame < 8; frame++ {
		tester.Frame()
		if got := textsJoined(tester); got != first {
			t.Fatalf("frame %d changed the context card\nbefore: %q\nafter:  %q", frame, first, got)
		}
	}
}
