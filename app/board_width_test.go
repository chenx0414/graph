package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestTheContextCardStopsShrinkingBeforeItsLegendTruncates(t *testing.T) {
	wide := contextOverviewShell(t, contextOverviewSettings)
	wideTester := frames(ui.NewTester(wide.view, 1440, 900))
	wideCard, ok := wideTester.Find("当前上下文窗口")
	if !ok {
		t.Fatalf("the context card never rendered, texts %q", wideTester.Texts())
	}
	narrow := contextOverviewShell(t, contextOverviewSettings)
	narrowTester := frames(ui.NewTester(narrow.view, 1280, 800))
	narrowCard, ok := narrowTester.Find("当前上下文窗口")
	if !ok {
		t.Fatalf("the context card never rendered at 1280, texts %q", narrowTester.Texts())
	}
	if narrowCard.W >= wideCard.W {
		t.Fatalf("the card still shrinks with the window: %0.1f at 1440 against %0.1f at 1280", wideCard.W, narrowCard.W)
	}
	if narrowCard.W < 520 {
		t.Fatalf("the context card keeps room for its three legend columns, got %0.1f", narrowCard.W)
	}
	for _, label := range []string{"系统提示词", "工具定义", "用户消息"} {
		if _, ok := narrowTester.Find(label); !ok {
			t.Fatalf("the legend label %q is missing at 1280, texts %q", label, narrowTester.Texts())
		}
	}
}

func TestALongFlowCardKeepsABasicWidthAndScrolls(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	state.openModule("fleet")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	for attempt := 0; attempt < 40 && state.fleet.data == nil && state.fleet.failed == ""; attempt++ {
		tester.Frame()
	}
	frames(tester)
	collaboration, ok := state.board.rects["fleet-collaboration"]
	if !ok {
		t.Fatalf("the collaboration card never laid out, rects %+v", state.board.rects)
	}
	if collaboration.W < boardLongFlowMinWidth {
		t.Fatalf("a long-flow card keeps its basic width %.0f, got %0.1f", boardLongFlowMinWidth, collaboration.W)
	}
}
