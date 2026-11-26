package main

import (
	"testing"
)

func TestASingleCardModulePageSitsOnTheWhiteboardBackdrop(t *testing.T) {
	state := fourPaneShell(t)
	state.openModule("settings")
	tester := frames(newTester(state.view, 1598, 928))
	rect, ok := state.board.rects["settings"]
	if !ok || rect.W <= 0 {
		t.Fatalf("the settings card never laid out, rects %+v", state.board.rects)
	}
	img := tester.Image()
	for name, corner := range map[string][2]int{
		"top-left":     {int(rect.X) + 1, int(rect.Y) + 1},
		"top-right":    {int(rect.X+rect.W) - 2, int(rect.Y) + 1},
		"bottom-left":  {int(rect.X) + 1, int(rect.Y+rect.H) - 2},
		"bottom-right": {int(rect.X+rect.W) - 2, int(rect.Y+rect.H) - 2},
	} {
		pixel := img.RGBAAt(corner[0], corner[1])
		if pixel.R >= 250 && pixel.G >= 250 && pixel.B >= 250 {
			t.Fatalf("the %s corner must be rounded, got %v", name, pixel)
		}
	}
	backdrop := img.RGBAAt(int(rect.X)-4, int(rect.Y)+int(rect.H/2))
	if backdrop.R >= 250 || backdrop.R < 200 {
		t.Fatalf("the card sits on the deeper whiteboard backdrop, got %v", backdrop)
	}
}

func TestTheHoverHeaderKeepsItsExpandAndRemoveActions(t *testing.T) {
	state := fourPaneShell(t)
	showTaskListBoard(state)
	tester := frames(newTester(state.view, 1440, 900))
	card, ok := tester.Find(boardPanelTitle("tasks") + "窗口")
	if !ok {
		t.Fatalf("the tasks card never rendered, texts %q", tester.Texts())
	}
	tester.Move(card.X+card.W/2, card.Y+card.H/2)
	tester.Advance(300 * 1e6)
	tester = frames(tester)
	for _, action := range []string{"在新标签页打开", "移除"} {
		if !tester.HasText(action) {
			t.Fatalf("the hover header keeps the %q action, texts %q", action, tester.Texts())
		}
	}
	if err := tester.Click("在新标签页打开"); err != nil {
		t.Fatalf("click the expand action: %v", err)
	}
	frames(tester)
	if state.activeBoardKind() != "tasks" {
		t.Fatalf("the expand action opens the card's page, kind %q", state.activeBoardKind())
	}
}
