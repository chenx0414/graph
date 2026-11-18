package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestTheWhiteboardScrollsBeyondOneScreen(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if state.boardScroll.MaxY <= 0 {
		t.Fatalf("the board page is taller than the window and scrolls, maxY %.1f", state.boardScroll.MaxY)
	}
	before, ok := tester.Find(boardPanelTitle("agent") + "窗口")
	if !ok {
		t.Fatalf("the agent card never rendered, texts %q", tester.Texts())
	}
	state.boardScroll.Y = state.boardScroll.MaxY
	tester = frames(tester)
	after, ok := tester.Find(boardPanelTitle("agent") + "窗口")
	if !ok {
		t.Fatalf("the agent card left the page, texts %q", tester.Texts())
	}
	if after.Y >= before.Y {
		t.Fatalf("scrolling down moves the lower cards up: before %+v after %+v", before, after)
	}
}

func TestTheFleetPageScrollsBeyondOneScreen(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	if state.boardScroll.MaxY <= 0 {
		t.Fatalf("the fleet page is taller than the window and scrolls, maxY %.1f", state.boardScroll.MaxY)
	}
	before, ok := tester.Find(boardPanelTitle("fleet-events") + "窗口")
	if !ok {
		t.Fatalf("the events card never rendered, texts %q", tester.Texts())
	}
	state.boardScroll.Y = state.boardScroll.MaxY
	tester = frames(tester)
	after, _ := tester.Find(boardPanelTitle("fleet-events") + "窗口")
	if after.Y >= before.Y {
		t.Fatalf("scrolling down moves the lower cards up: before %+v after %+v", before, after)
	}
}

func boardReveal(t *testing.T, tester *ui.Tester, state *shellState, label string) {
	t.Helper()
	state.boardScroll.Y = 0
	frames(tester)
	rect, ok := tester.Find(label)
	if !ok {
		t.Fatalf("%q never rendered, texts %q", label, tester.Texts())
	}
	state.boardScroll.Y = max(0, min(state.boardScroll.MaxY, rect.Y-120))
	frames(tester)
	if shown, ok := tester.Find(label); !ok || shown.W <= 0 || shown.H <= 0 {
		t.Fatalf("scrolling the page never brought %q into view, rect %+v", label, shown)
	}
}

func boardContentRects(t *testing.T, tester *ui.Tester, state *shellState, labels []string) map[string]ui.Rect {
	t.Helper()
	rects := map[string]ui.Rect{}
	state.boardScroll.Y = 0
	frames(tester)
	collect := func() {
		for _, label := range labels {
			if _, done := rects[label]; done {
				continue
			}
			rect, ok := tester.Find(label)
			if !ok || rect.W <= 0 || rect.H <= 0 {
				continue
			}
			rect.Y += state.boardScroll.Y
			rects[label] = rect
		}
	}
	collect()
	state.boardScroll.Y = state.boardScroll.MaxY
	frames(tester)
	collect()
	return rects
}
