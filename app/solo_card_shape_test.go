package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestASingleCardModulePageSquaresItsLeftCorners(t *testing.T) {
	state := fourPaneShell(t)
	state.openModule("settings")
	tester := frames(ui.NewTester(state.view, 1598, 928))
	rect, ok := state.board.rects["settings"]
	if !ok || rect.W <= 0 {
		t.Fatalf("the settings card never laid out, rects %+v", state.board.rects)
	}
	img := tester.Image()
	card := img.RGBAAt(int(rect.X)+1, int(rect.Y)+1)
	backdrop := img.RGBAAt(int(rect.X)-2, int(rect.Y)+1)
	if card.R < 250 || card.G < 250 || card.B < 250 {
		t.Fatalf("the top-left corner is rounded: %v against backdrop %v", card, backdrop)
	}
	right := img.RGBAAt(int(rect.X+rect.W)-2, int(rect.Y)+1)
	if right.R >= 250 && right.G >= 250 && right.B >= 250 {
		t.Fatalf("the top-right corner must stay rounded, got %v", right)
	}
}

func TestTheCardHeaderOffersNoClickableActions(t *testing.T) {
	state := fourPaneShell(t)
	showTaskListBoard(state)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	card, ok := tester.Find(boardPanelTitle("tasks") + "窗口")
	if !ok {
		t.Fatalf("the tasks card never rendered, texts %q", tester.Texts())
	}
	tester.Move(card.X+card.W/2, card.Y+card.H/2)
	tester.Advance(300 * 1e6)
	tester = frames(tester)
	for _, action := range []string{"在新标签页打开", "移除"} {
		if tester.HasText(action) {
			t.Fatalf("the card header carries the %q action, texts %q", action, tester.Texts())
		}
	}
	tester.RightClickAt(card.X+card.W/2, card.Y+card.H/2)
	menu := tester.Menu()
	if len(menu) == 0 {
		t.Fatalf("the card keeps its actions in a context menu, menu %q", menu)
	}
}
