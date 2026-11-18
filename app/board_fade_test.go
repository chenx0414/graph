package main

import (
	"fmt"
	"math"
	"testing"

	"github.com/egoist/mygo/ui"
)

func fadeInsetTester(t *testing.T) (*shellState, *ui.Tester) {
	t.Helper()
	state := fourPaneShell(t)
	state.conversations = nil
	for index := 0; index < 40; index++ {
		state.conversations = append(state.conversations, conversationSummary{
			ID:    fmt.Sprintf("c%02d", index),
			Title: fmt.Sprintf("历史行 %02d", index),
		})
	}
	panel := boardPanel{ID: "history", Kind: "history"}
	view := func(ctx *ui.Context) {
		ui.Column(ctx).Fill().Padding(60).Children(func() {
			card := ui.Column(ctx).FillWidth().Height(400).Label(boardPanelTitle("history") + "窗口")
			card.Children(func() {
				state.boardPanelView(ctx, &panel, false, boardHeaderNone)
			})
		})
	}
	return state, frames(ui.NewTester(view, 1440, 900))
}

func fadeCard(t *testing.T, tester *ui.Tester) ui.Rect {
	t.Helper()
	card, ok := tester.Find(boardPanelTitle("history") + "窗口")
	if !ok {
		t.Fatalf("the history card never rendered, texts %q", tester.Texts())
	}
	return card
}

func TestACardScrollKeepsTheTopRowClearOfTheFade(t *testing.T) {
	state, tester := fadeInsetTester(t)
	scroll := state.board.scrolls["history"]
	if scroll == nil || scroll.MaxY < 200 {
		t.Fatalf("the history card must scroll, scroll %+v", scroll)
	}
	card := fadeCard(t, tester)
	row, ok := tester.Find("历史行 00")
	if !ok {
		t.Fatalf("the history rows never rendered, texts %q", tester.Texts())
	}
	if gap := row.Y - card.Y; math.Abs(float64(gap-boardPanelPadding-fadeEdgeClearance)) > 1 {
		t.Fatalf("a card at its top clears the fade by %.1f, got %.1f: card %+v row %+v", fadeEdgeClearance, gap, card, row)
	}
	topMax := scroll.MaxY
	scroll.Y = topMax / 2
	tester = frames(tester)
	if got := topMax - scroll.MaxY; math.Abs(float64(got-fadeEdgeClearance)) > 1 {
		t.Fatalf("a card at its top pads its content by %.1f, got %.1f: at top %.1f middle %.1f", fadeEdgeClearance, got, topMax, scroll.MaxY)
	}
}

func TestACardScrollKeepsTheLastRowClearOfTheFade(t *testing.T) {
	state, tester := fadeInsetTester(t)
	scroll := state.board.scrolls["history"]
	if scroll == nil || scroll.MaxY < 200 {
		t.Fatalf("the history card must scroll, scroll %+v", scroll)
	}
	card := fadeCard(t, tester)
	scroll.Y = math.MaxFloat32
	tester = frames(tester)
	row, ok := tester.Find("历史行 39")
	if !ok || row.H <= 0 {
		t.Fatalf("the last row never rendered at the end, %+v texts %q", row, tester.Texts())
	}
	if gap := card.Y + card.H - (row.Y + row.H); math.Abs(float64(gap-boardPanelPadding-fadeEdgeClearance)) > 1 {
		t.Fatalf("a card at its end clears the fade by %.1f, got %.1f: card %+v row %+v", fadeEdgeClearance, gap, card, row)
	}
	endMax := scroll.MaxY
	scroll.Y = endMax / 2
	tester = frames(tester)
	if got := endMax - scroll.MaxY; math.Abs(float64(got-fadeEdgeClearance)) > 1 {
		t.Fatalf("a card at its end pads its content by %.1f, got %.1f: end %.1f middle %.1f", fadeEdgeClearance, got, endMax, scroll.MaxY)
	}
}

func TestFadeInsetsClearOnlyTheEndsTheScrollRestsOn(t *testing.T) {
	for _, sample := range []struct {
		y, maxY     float32
		top, bottom float32
	}{
		{0, 400, fadeEdgeClearance, 0},
		{200, 400, 0, 0},
		{400, 400, 0, fadeEdgeClearance},
		{0, 0, 0, 0},
	} {
		top, bottom := fadeInsets(&ui.ScrollState{Y: sample.y, MaxY: sample.maxY})
		if top != sample.top || bottom != sample.bottom {
			t.Fatalf("fadeInsets at %0.1f of %0.1f = (%0.1f, %0.1f), want (%0.1f, %0.1f)", sample.y, sample.maxY, top, bottom, sample.top, sample.bottom)
		}
	}
	if top, bottom := fadeInsets(nil); top != 0 || bottom != 0 {
		t.Fatalf("fadeInsets without a scroll state = (%0.1f, %0.1f)", top, bottom)
	}
}
