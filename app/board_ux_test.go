package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestAModulePageShowsItsTitleOnlyOnce(t *testing.T) {
	state := fourPaneShell(t)
	state.openModule("models")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	title := boardPanelTitle("models")
	count := 0
	for _, text := range tester.Texts() {
		if text == title {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("a module page shows its title once, got %d in %q", count, tester.Texts())
	}
}

func TestTheRailNoLongerOffersTheInsightsPage(t *testing.T) {
	for _, item := range railItems {
		if item.kind == "insights" || item.label == "洞察" {
			t.Fatalf("the rail still offers the insights page: %+v", item)
		}
	}
	for _, page := range defaultBoardPages() {
		for _, panel := range page.Panels {
			if strings.Contains(panel.Kind, "insights") {
				t.Fatalf("the default board carries an insights card: %+v", panel)
			}
		}
	}
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if tester.HasText("洞察") {
		t.Fatalf("the shell still renders an insights entry, texts %q", tester.Texts())
	}
	if got := boardPanelTitle("insights"); got == "洞察概览" {
		t.Fatalf("the insights title survived the removal: %q", got)
	}
}

func TestTheFleetPageDropsTheTaskCard(t *testing.T) {
	for _, panel := range defaultFleetPanels() {
		if panel.Kind == "fleet-tasks" || panel.ID == "fleet-tasks" {
			t.Fatalf("the default fleet page keeps the task card: %+v", panel)
		}
	}
	page := defaultFleetPage()
	if leaves := boardLeafIDs(&page.Layout); len(leaves) != len(defaultFleetPanels()) {
		t.Fatalf("the default fleet layout matches its panels, leaves %v panels %+v", leaves, defaultFleetPanels())
	}
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	if tester.HasText("协作任务") {
		t.Fatalf("the fleet page still shows the task card, texts %q", tester.Texts())
	}
	if got := boardPanelTitle("fleet-tasks"); got == "协作任务" {
		t.Fatalf("the fleet task title survived the removal: %q", got)
	}
}

func TestTheDefaultBoardShowsTheContextNetworkAndCollaboration(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	for _, label := range []string{"当前上下文窗口", "Agent 网络窗口", "跨 Agent 协作窗口"} {
		if !tester.HasText(label) {
			t.Fatalf("the default board must present %q, texts %q", label, tester.Texts())
		}
	}
	for _, gone := range []string{"Agent 面板窗口", "轨迹量化窗口"} {
		if tester.HasText(gone) {
			t.Fatalf("the default board must drop %q, texts %q", gone, tester.Texts())
		}
	}
	rects := map[string]ui.Rect{}
	for _, kind := range []string{"context-overview", "agent-network", "fleet-collaboration"} {
		rect, ok := tester.Find(boardPanelTitle(kind) + "窗口")
		if !ok {
			t.Fatalf("%s never rendered, texts %q", kind, tester.Texts())
		}
		rects[kind] = rect
	}
	names := []string{"context-overview", "agent-network", "fleet-collaboration"}
	for first := 0; first < len(names); first++ {
		for second := first + 1; second < len(names); second++ {
			a, b := rects[names[first]], rects[names[second]]
			if a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H {
				t.Fatalf("panes must not overlap: %s %+v vs %s %+v", names[first], a, names[second], b)
			}
		}
	}
	overview, network := rects["context-overview"], rects["agent-network"]
	collaboration := rects["fleet-collaboration"]
	if overview.Y >= network.Y || network.Y >= collaboration.Y {
		t.Fatalf("the board stacks overview, network, then collaboration: %+v", rects)
	}
	if overview.X != network.X || overview.X != collaboration.X {
		t.Fatalf("the three cards start at the same x: %+v", rects)
	}
	if overview.W != network.W || overview.W != collaboration.W {
		t.Fatalf("the three cards take the whole width: %+v", rects)
	}
	if overview.H < boardMinPaneHeight || network.H < boardMinPaneHeight || collaboration.H < boardMinPaneHeight {
		t.Fatalf("every card clears the minimum pane height %d: %+v", boardMinPaneHeight, rects)
	}
}

func TestTheFleetCardsRevealTheirHeaderOnHover(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	hidden := []string{"编队总览", "Agent 网络", "事件检查", "共享产物"}
	visible := func(tester *ui.Tester) []string {
		shown := []string{}
		for _, title := range hidden {
			for _, text := range tester.Texts() {
				if text == title {
					shown = append(shown, title)
					break
				}
			}
		}
		return shown
	}
	if shown := visible(tester); len(shown) != 0 {
		t.Fatalf("the fleet cards start with their headers tucked away, shown %q texts %q", shown, tester.Texts())
	}
	if tester.HasText("在新标签页打开") {
		t.Fatalf("the fleet cards keep a permanent header, texts %q", tester.Texts())
	}
	for _, kind := range []string{"fleet-kpi", "fleet-network", "fleet-collaboration", "fleet-events", "fleet-artifacts"} {
		rect, ok := state.board.rects[kind]
		if !ok || rect.W <= 0 || rect.H <= 0 {
			t.Fatalf("%s never laid out, rects %+v", kind, state.board.rects)
		}
		tester.Move(rect.X+rect.W/2, rect.Y+rect.H/2)
		tester.Advance(300 * 1e6)
		tester = frames(tester)
		if !tester.HasText("在新标签页打开") {
			t.Fatalf("hovering %s must reveal its header, texts %q", kind, tester.Texts())
		}
		if shown := visible(tester); len(shown) > 1 {
			t.Fatalf("only the hovered card shows its header, shown %q", shown)
		}
	}
	tester.Move(10, 10)
	tester.Advance(300 * 1e6)
	tester = frames(tester)
	if shown := visible(tester); len(shown) != 0 {
		t.Fatalf("the headers tuck away when the pointer leaves, shown %q texts %q", shown, tester.Texts())
	}
}

func TestTheDefaultFleetCardsKeepTheirInformationAtBothWindowSizes(t *testing.T) {
	for _, size := range [][2]int{{1440, 900}, {1280, 800}} {
		state := fleetServerShell(t, fleetSampleServer)
		state.openModule("fleet")
		tester := frames(ui.NewTester(state.view, size[0], size[1]))
		for attempt := 0; attempt < 20 && state.fleet.data == nil && state.fleet.failed == ""; attempt++ {
			tester.Frame()
		}
		frames(tester)
		kinds := []string{"fleet-kpi", "fleet-network", "fleet-collaboration", "fleet-events", "fleet-artifacts"}
		rects := map[string]ui.Rect{}
		for _, kind := range kinds {
			rect, ok := state.board.rects[kind]
			if !ok {
				t.Fatalf("%dx%d: %s never laid out, rects %+v", size[0], size[1], kind, state.board.rects)
			}
			rects[kind] = rect
			if rect.H < boardMinPaneHeight {
				t.Fatalf("%dx%d: %s is %0.1f high, want at least %d: %+v", size[0], size[1], kind, rect.H, boardMinPaneHeight, rect)
			}
			if rect.W < boardMinPaneWidth {
				t.Fatalf("%dx%d: %s is %0.1f wide, want at least %d: %+v", size[0], size[1], kind, rect.W, boardMinPaneWidth, rect)
			}
		}
		for first := 0; first < len(kinds); first++ {
			for second := first + 1; second < len(kinds); second++ {
				a, b := rects[kinds[first]], rects[kinds[second]]
				if a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H {
					t.Fatalf("%dx%d: %s %+v overlaps %s %+v", size[0], size[1], kinds[first], a, kinds[second], b)
				}
			}
		}
		if rects["fleet-network"].H < 150 {
			t.Fatalf("%dx%d: the network card is %0.1f high, want at least 150 to show the ring", size[0], size[1], rects["fleet-network"].H)
		}
		if rects["fleet-collaboration"].H < 260 {
			t.Fatalf("%dx%d: the collaboration card is %0.1f high, want at least 260 to show two lanes and its head", size[0], size[1], rects["fleet-collaboration"].H)
		}
	}
}

func TestTheDefaultBoardGivesEachCardItsAdmiralShare(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 2000, 1400))
	heights := map[string]float32{}
	for _, kind := range []string{"context-overview", "agent-network", "fleet-collaboration"} {
		rect, ok := tester.Find(boardPanelTitle(kind) + "窗口")
		if !ok {
			t.Fatalf("%s never rendered, texts %q", kind, tester.Texts())
		}
		heights[kind] = rect.H
	}
	total := heights["context-overview"] + heights["agent-network"] + heights["fleet-collaboration"]
	want := map[string]float32{
		"context-overview":    0.221,
		"agent-network":       0.466,
		"fleet-collaboration": 0.313,
	}
	for kind, share := range want {
		got := heights[kind] / total
		if diff := got - share; diff > 0.02 || diff < -0.02 {
			t.Fatalf("%s takes %.3f of the board, want %.3f (heights %+v)", kind, got, share, heights)
		}
	}
}

func TestTheFleetCollaborationCardFitsItsLanesInsteadOfStretching(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	state.openModule("fleet")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	for attempt := 0; attempt < 20 && state.fleet.data == nil && state.fleet.failed == ""; attempt++ {
		tester.Frame()
	}
	frames(tester)
	collaboration, ok := state.board.rects["fleet-collaboration"]
	if !ok {
		t.Fatalf("the collaboration card never laid out, rects %+v", state.board.rects)
	}
	kpi := state.board.rects["fleet-kpi"]
	network := state.board.rects["fleet-network"]
	if collaboration.H >= network.H*1.6 {
		t.Fatalf("the collaboration card takes %0.1f against the network card's %0.1f; it must not dominate the page", collaboration.H, network.H)
	}
	if collaboration.H > kpi.H*3.4 {
		t.Fatalf("the collaboration card takes %0.1f against the KPI card's %0.1f; its lanes do not need that much room", collaboration.H, kpi.H)
	}
}
