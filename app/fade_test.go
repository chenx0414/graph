package main

import (
	"fmt"
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

func TestTheFadeInsetGrowsOnlyOnTheEdgeTheContentRestsOn(t *testing.T) {
	for _, sample := range []struct {
		name        string
		y, maxY     float32
		top, bottom float32
	}{
		{"at the top", 0, 400, fadeEdgeClearance, 0},
		{"away from both", 200, 400, 0, 0},
		{"at the end", 400, 400, 0, fadeEdgeClearance},
		{"past the end", 600, 400, 0, fadeEdgeClearance},
		{"nothing to scroll", 0, 0, 0, 0},
	} {
		top, bottom := (&edgeScroll{ScrollState: ui.ScrollState{Y: sample.y, MaxY: sample.maxY}}).insets()
		if top != sample.top || bottom != sample.bottom {
			t.Fatalf("%s: insets = (%0.2f, %0.2f), want (%0.2f, %0.2f)", sample.name, top, bottom, sample.top, sample.bottom)
		}
	}
	if top, bottom := (*edgeScroll)(nil).insets(); top != 0 || bottom != 0 {
		t.Fatalf("insets without a scroll state = (%0.2f, %0.2f)", top, bottom)
	}
}

func TestTheFadeMaskOnlyFadesAnEdgeWithMoreBehindIt(t *testing.T) {
	atTop := (&edgeScroll{ScrollState: ui.ScrollState{Y: 0, MaxY: 400}}).mask()
	if atTop.Stops[1].At != 0 {
		t.Fatalf("a scroll resting at its top must not fade its first line, top band %0.2f", atTop.Stops[1].At)
	}
	if atTop.Stops[2].At != 1-fadeBand {
		t.Fatalf("a scroll resting at its top still fades its end, bottom band %0.2f", atTop.Stops[2].At)
	}
	atEnd := (&edgeScroll{ScrollState: ui.ScrollState{Y: 400, MaxY: 400}}).mask()
	if atEnd.Stops[2].At != 1 {
		t.Fatalf("a scroll resting at its end must not fade its last line, bottom band %0.2f", atEnd.Stops[2].At)
	}
	if atEnd.Stops[1].At != fadeBand {
		t.Fatalf("a scroll resting at its end still fades its top, top band %0.2f", atEnd.Stops[1].At)
	}
	middle := (&edgeScroll{ScrollState: ui.ScrollState{Y: 200, MaxY: 400}}).mask()
	if middle.Stops[1].At != fadeBand || middle.Stops[2].At != 1-fadeBand {
		t.Fatalf("a scroll with more on both sides fades both: top %0.2f bottom %0.2f", middle.Stops[1].At, middle.Stops[2].At)
	}
	still := (&edgeScroll{}).mask()
	if still.Stops[1].At != 0 || still.Stops[2].At != 1 {
		t.Fatalf("a scroll that cannot scroll shows no fade at all: top %0.2f bottom %0.2f", still.Stops[1].At, still.Stops[2].At)
	}
}
