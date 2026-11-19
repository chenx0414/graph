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

func TestTheContextCardKeepsRoomForItsWholeContent(t *testing.T) {
	state := contextOverviewShell(t, contextOverviewSettings)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	card, ok := tester.Find("当前上下文窗口")
	if !ok {
		t.Fatalf("the context card never rendered, texts %q", tester.Texts())
	}
	for _, label := range []string{"当前上下文", "上下文", "620.7k"} {
		rect, ok := tester.Find(label)
		if !ok {
			continue
		}
		if rect.Y+rect.H > card.Y+card.H+1 {
			t.Fatalf("%q runs past the card's bottom edge: label %+v card %+v", label, rect, card)
		}
	}
	if _, ok := tester.Find("系统提示词"); !ok {
		t.Fatalf("the legend rows fit inside the card, texts %q", tester.Texts())
	}
}

func TestTheContextCardKeepsItsLegendInsideAtEveryWindowSize(t *testing.T) {
	for _, size := range [][2]int{{1440, 900}, {1280, 800}} {
		state := contextOverviewShell(t, contextOverviewSettings)
		tester := frames(ui.NewTester(state.view, size[0], size[1]))
		card, ok := tester.Find("当前上下文窗口")
		if !ok {
			t.Fatalf("%dx%d: the context card never rendered, texts %q", size[0], size[1], tester.Texts())
		}
		for _, label := range []string{"系统提示词", "注入内容"} {
			rect, ok := tester.Find(label)
			if !ok {
				t.Fatalf("%dx%d: the legend label %q is missing, texts %q", size[0], size[1], label, tester.Texts())
			}
			if rect.H <= 0 {
				t.Fatalf("%dx%d: the legend label %q is clipped to nothing", size[0], size[1], label)
			}
			if rect.Y+rect.H > card.Y+card.H+2 {
				t.Fatalf("%dx%d: %q runs past the card's bottom edge: label %+v card %+v", size[0], size[1], label, rect, card)
			}
		}
	}
}

func TestTheCollaborationCardKeepsRoomForBothLanesAtEveryWindowSize(t *testing.T) {
	for _, size := range [][2]int{{1598, 928}, {1440, 900}, {1280, 800}} {
		state := contextOverviewShell(t, contextOverviewSettings)
		tester := frames(ui.NewTester(state.view, size[0], size[1]))
		card, ok := tester.Find("跨 Agent 协作窗口")
		if !ok {
			t.Fatalf("%dx%d: the collaboration card never rendered, texts %q", size[0], size[1], tester.Texts())
		}
		if card.H < boardCollaborationMinHeight {
			t.Fatalf("%dx%d: the collaboration card is %0.1f high, want at least %.0f for its two lanes",
				size[0], size[1], card.H, boardCollaborationMinHeight)
		}
	}
}

func TestEveryModuleCardKeepsItsHeaderTuckedAwayUntilHover(t *testing.T) {
	state := contextOverviewShell(t, contextOverviewSettings)
	state.openModule("trajectory")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	shown := func() bool {
		for _, text := range tester.Texts() {
			if text == "上下文统计" {
				return true
			}
		}
		return false
	}
	if shown() {
		t.Fatalf("a module card shows a permanent header, texts %q", tester.Texts())
	}
	card, ok := tester.Find(boardPanelTitle("trajectory-summary") + "窗口")
	if !ok {
		t.Fatalf("the summary card never rendered, texts %q", tester.Texts())
	}
	tester.Move(card.X+card.W/2, card.Y+card.H/2)
	tester.Advance(300 * 1e6)
	tester = frames(tester)
	if !shown() {
		t.Fatalf("hovering a module card reveals its header, texts %q", tester.Texts())
	}
}

func TestEveryCardKindDeclaresAMinimumHeight(t *testing.T) {
	state := fourPaneShell(t)
	var missing []string
	var tooSmall []string
	frames(ui.NewTester(func(ctx *ui.Context) {
		for _, kind := range boardPanelAllKinds() {
			panel := &boardPanel{ID: kind, Kind: kind}
			height := state.boardPanelMinHeight(ctx, panel)
			if height <= 0 {
				missing = append(missing, kind)
				continue
			}
			if height < boardMinimumCardHeight {
				tooSmall = append(tooSmall, kind)
			}
		}
		ui.Column(ctx).Fill()
	}, 100, 100))
	if len(missing) > 0 {
		t.Fatalf("every card kind declares a minimum height, missing %v", missing)
	}
	if len(tooSmall) > 0 {
		t.Fatalf("every card keeps a usable minimum height, too small %v", tooSmall)
	}
}

func TestTheBoardScrollsInsteadOfSqueezingCardsBelowTheirMinimum(t *testing.T) {
	state := contextOverviewShell(t, contextOverviewSettings)
	frames(ui.NewTester(state.view, 1024, 640))
	for _, kind := range []string{"context-overview", "agent-network", "fleet-collaboration"} {
		card, ok := state.board.rects[kind]
		if !ok {
			t.Fatalf("%s never laid out at the minimum window, rects %+v", kind, state.board.rects)
		}
		var want float32
		frames(ui.NewTester(func(ctx *ui.Context) {
			want = state.boardPanelMinHeight(ctx, &boardPanel{ID: kind, Kind: kind})
			ui.Column(ctx).Fill()
		}, 100, 100))
		if card.H < want-1 {
			t.Fatalf("%s is %0.1f high at the minimum window, want at least %0.1f", kind, card.H, want)
		}
	}
}
