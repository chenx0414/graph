package main

import (
	"encoding/json"
	"image/color"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestTheBoardShowsTheContextOverviewNetworkAndChatCards(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	for _, label := range []string{"当前上下文窗口", "Agent 网络窗口", "跨 Agent 协作窗口"} {
		if !tester.HasText(label) {
			t.Fatalf("the default board must present %q, texts %q", label, tester.Texts())
		}
	}
	for _, gone := range []string{"洞察概览窗口", "Agent 面板窗口", "轨迹量化窗口"} {
		if tester.HasText(gone) {
			t.Fatalf("the default board drops %q, texts %q", gone, tester.Texts())
		}
	}
}

func TestTheBoardKeepsFixedNonOverlappingPartitions(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
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
	if overview.W <= collaboration.W*0.9 || network.W <= collaboration.W*0.9 {
		t.Fatalf("every card takes the whole column, overview %.1f network %.1f collaboration %.1f", overview.W, network.W, collaboration.W)
	}
	if overview.X != collaboration.X || overview.W != collaboration.W {
		t.Fatalf("the cards share one column: overview %+v collaboration %+v", overview, collaboration)
	}
}

func TestDraggingAPanelBodySwapsItsPartition(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	network := state.board.rects["agent-network"]
	collaboration := state.board.rects["fleet-collaboration"]
	if network.H <= 0 || collaboration.H <= 0 {
		t.Fatalf("the board must know its partitions, rects %+v", state.board.rects)
	}
	startX, startY := network.X+network.W/2, network.Y+network.H*0.6
	endX, endY := collaboration.X+collaboration.W/2, collaboration.Y+collaboration.H*0.6
	tester.Press(startX, startY)
	for step := 1; step <= 12; step++ {
		tester.Move(startX+(endX-startX)*float32(step)/12, startY+(endY-startY)*float32(step)/12)
		tester.Frame()
	}
	tester.Release(endX, endY)
	frames(tester)
	page := state.boardPage()
	if leaves := boardLeafIDs(&page.Layout); len(leaves) != 3 || leaves[0] != "context-overview" || leaves[1] != "fleet-collaboration" || leaves[2] != "agent-network" {
		t.Fatalf("a center drop swaps the two partitions, leaves %v", leaves)
	}
}

func TestDraggingToAPartitionEdgeSplitsIt(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	network := state.board.rects["agent-network"]
	collaboration := state.board.rects["fleet-collaboration"]
	if network.H <= 0 || collaboration.H <= 0 {
		t.Fatalf("the board must know its partitions, rects %+v", state.board.rects)
	}
	startX, startY := network.X+network.W/2, network.Y+network.H*0.6
	endX, endY := collaboration.X+8, collaboration.Y+collaboration.H/2
	tester.Press(startX, startY)
	for step := 1; step <= 12; step++ {
		tester.Move(startX+(endX-startX)*float32(step)/12, startY+(endY-startY)*float32(step)/12)
		tester.Frame()
	}
	tester.Release(endX, endY)
	frames(tester)
	page := state.boardPage()
	leaves := boardLeafIDs(&page.Layout)
	if len(leaves) != len(page.Panels) {
		t.Fatalf("a split keeps every module on the board, leaves %v layout %+v rects %+v", leaves, page.Layout, state.board.rects)
	}
	seen := map[string]bool{}
	for _, id := range leaves {
		if seen[id] {
			t.Fatalf("a module appears twice after the split, leaves %v", leaves)
		}
		seen[id] = true
	}
	after := state.board.rects
	if after["agent-network"].X >= after["fleet-collaboration"].X {
		t.Fatalf("dropping on the left edge puts the dragged pane before the target: network %+v collaboration %+v", after["agent-network"], after["fleet-collaboration"])
	}
}

func TestADividerDragResizesBothPartitions(t *testing.T) {
	state := fourPaneShell(t)
	page := &state.board.pages[0]
	page.Panels = []boardPanel{{ID: "events", Kind: "fleet-events"}, {ID: "artifacts", Kind: "fleet-artifacts"}}
	page.Layout = boardNode{Kind: "split", Axis: "row", Children: []boardSlot{
		{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "events"}},
		{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "artifacts"}},
	}}
	tester := frames(newTester(state.view, 1440, 900))
	before, ok := tester.Find(boardPanelTitle("fleet-events") + "窗口")
	if !ok {
		t.Fatalf("the events card never rendered, texts %q", tester.Texts())
	}
	right, ok := tester.Find(boardPanelTitle("fleet-artifacts") + "窗口")
	if !ok {
		t.Fatalf("the artifacts card never rendered, texts %q", tester.Texts())
	}
	x, y := (before.X+before.W+right.X)/2, before.Y+before.H/2
	tester.Press(x, y)
	for step := 1; step <= 10; step++ {
		tester.Move(x+float32(step)*8, y)
		tester.Frame()
	}
	tester.Release(x+80, y)
	frames(tester)
	after, _ := tester.Find(boardPanelTitle("fleet-events") + "窗口")
	if after.W <= before.W {
		t.Fatalf("dragging the divider right must widen the left partition: before %.1f after %.1f", before.W, after.W)
	}
}

func TestAnOldFreeformBoardMigratesIntoPartitions(t *testing.T) {
	directory := t.TempDir()
	legacy := `{"version":3,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"agent","kind":"agent","slot":0},
		{"id":"agent-network","kind":"agent-network","slot":1}
	]}]}`
	if err := os.WriteFile(filepath.Join(directory, "whiteboard.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	state := newShellState("http://127.0.0.1:1", "tok")
	state.loadBoard(directory)
	page := state.boardPage()
	if leaves := boardLeafIDs(&page.Layout); len(leaves) != 3 || leaves[0] != "context-overview" || leaves[1] != "agent-network" || leaves[2] != "fleet-collaboration" {
		t.Fatalf("a freeform board migrates into the dashboard layout, leaves %v", leaves)
	}
	if page.Kind != "" {
		t.Fatalf("the migrated page stays a board, kind %q", page.Kind)
	}
}

func TestTheBoardRemembersItsLayout(t *testing.T) {
	directory := t.TempDir()
	first := newShellState("http://127.0.0.1:1", "tok")
	first.loadBoard(directory)
	swapBoardPanels(&first.boardPage().Layout, "agent-network", "fleet-collaboration")
	first.saveBoard()

	second := newShellState("http://127.0.0.1:1", "tok")
	second.loadBoard(directory)
	leaves := boardLeafIDs(&second.boardPage().Layout)
	if len(leaves) != 3 || leaves[1] != "fleet-collaboration" || leaves[2] != "agent-network" {
		t.Fatalf("saved partitions not restored: leaves %v", leaves)
	}
}

func TestLoadingTheBoardDropsTheRemovedPages(t *testing.T) {
	state := fourPaneShell(t)
	dir := t.TempDir()
	payload, err := json.Marshal(boardFile{
		Version: boardLayoutVersion,
		Pages: []boardPage{
			{ID: "board", Title: boardDefaultTitle, Panels: defaultBoardPanels(), Layout: defaultBoardLayout()},
			{ID: "tab-history", Title: "历史记录", Kind: "history", Panels: []boardPanel{{ID: "history", Kind: "history"}}, Layout: boardNode{Kind: "panel", PanelID: "history"}},
			{ID: "tab-conversation", Title: "对话信息", Kind: "conversation", Panels: []boardPanel{{ID: "conversation", Kind: "conversation"}}, Layout: boardNode{Kind: "panel", PanelID: "conversation"}},
			{ID: "tab-graph", Title: "图谱画布", Kind: "graph", Panels: []boardPanel{{ID: "graph", Kind: "graph"}}, Layout: boardNode{Kind: "panel", PanelID: "graph"}},
		},
		Active: 2,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "whiteboard.json"), payload, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	state.loadBoard(dir)
	if len(state.board.pages) != 1 || state.board.pages[0].Kind != "" {
		t.Fatalf("removed pages survived, pages %+v", state.board.pages)
	}
	for _, panel := range state.board.pages[0].Panels {
		if panel.Kind == "history" || panel.Kind == "conversation" || panel.Kind == "graph" {
			t.Fatalf("removed panel survived, panels %+v", state.board.pages[0].Panels)
		}
	}
	for _, id := range boardLeafIDs(&state.board.pages[0].Layout) {
		if id == "history" || id == "conversation" {
			t.Fatalf("removed panel leaf survived, leaves %v", boardLeafIDs(&state.board.pages[0].Layout))
		}
	}
	frames(newTester(state.view, 1440, 900))
}

func TestLoadingAnOldBoardAddsTheTrajectoryAndInsightsCards(t *testing.T) {
	state := fourPaneShell(t)
	dir := t.TempDir()
	legacy := `{"version":4,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"agent","kind":"agent","slot":0},
		{"id":"agent-network","kind":"agent-network","slot":1},
		{"id":"overview","kind":"overview","slot":2}
	]}]}`
	if err := os.WriteFile(filepath.Join(dir, "whiteboard.json"), []byte(legacy), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	state.loadBoard(dir)
	page := state.boardPage()
	kinds := map[string]bool{}
	for _, panel := range page.Panels {
		kinds[panel.Kind] = true
	}
	if kinds["overview"] || kinds["insights"] || kinds["trajectory"] || kinds["agent"] || !kinds["context-overview"] || !kinds["agent-network"] || !kinds["fleet-collaboration"] {
		t.Fatalf("the old board must trade overview and insights for the dashboard cards, panels %+v", page.Panels)
	}
}

func showTaskListBoard(state *shellState) {
	page := &state.board.pages[0]
	page.Panels = []boardPanel{{ID: "tasks", Kind: "tasks"}}
	page.Layout = boardNode{Kind: "panel", PanelID: "tasks"}
}

func TestTheWhiteboardHeaderSlidesOverItsContentWithoutMovingIt(t *testing.T) {
	state := fourPaneShell(t)
	showTaskListBoard(state)
	tester := frames(newTester(state.view, 1440, 900))
	card, ok := tester.Find(boardPanelTitle("tasks") + "窗口")
	if !ok {
		t.Fatalf("the tasks card never rendered, texts %q", tester.Texts())
	}
	content, ok := tester.Find("实现四栏页面 · running · executing")
	if !ok {
		t.Fatalf("the task row never rendered, texts %q", tester.Texts())
	}
	hasTitle := func() bool { return tester.HasText("任务清单标题") }
	if hasTitle() {
		t.Fatalf("the card header starts tucked away, texts %q", tester.Texts())
	}
	tester.Move(card.X+card.W/2, card.Y+card.H/2)
	tester.Advance(300 * time.Millisecond)
	frames(tester)
	if !hasTitle() {
		t.Fatalf("hovering reveals the card header, texts %q", tester.Texts())
	}
	after, ok := tester.Find("实现四栏页面 · running · executing")
	if !ok {
		t.Fatalf("the task row left the card, texts %q", tester.Texts())
	}
	if after.Y != content.Y {
		t.Fatalf("the content moved from %v to %v when the header showed", content.Y, after.Y)
	}
}

func TestTheWhiteboardKeepsTheCardScrollWhenThePointerLeaves(t *testing.T) {
	state := fourPaneShell(t)
	showTaskListBoard(state)
	tester := frames(newTester(state.view, 1440, 900))
	card, ok := tester.Find(boardPanelTitle("tasks") + "窗口")
	if !ok {
		t.Fatalf("the tasks card never rendered, texts %q", tester.Texts())
	}
	tester.Wheel(card.X+card.W/2, card.Y+card.H/2, 0, -120)
	frames(tester)
	row, ok := tester.Find("实现四栏页面 · running · executing")
	if !ok {
		t.Fatalf("the task row never rendered, texts %q", tester.Texts())
	}
	tester.Move(10, 10)
	tester.Advance(400 * time.Millisecond)
	frames(tester)
	after, ok := tester.Find("实现四栏页面 · running · executing")
	if !ok {
		t.Fatalf("the task row disappeared, texts %q", tester.Texts())
	}
	if after.Y != row.Y {
		t.Fatalf("the card reset its scroll from %v to %v", row.Y, after.Y)
	}
}

func TestAModulePageShowsItsTitleWithoutACardHeader(t *testing.T) {
	state := fourPaneShell(t)
	state.openModule("models")

	tester := frames(newTester(state.view, 1440, 900))
	title := boardPanelTitle("models")
	if tester.HasText(title + "窗口") {
		t.Fatalf("the module page repeats the title in a card header, texts %q", tester.Texts())
	}
	count := 0
	for _, text := range tester.Texts() {
		if text == title {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("the module page shows %q %d times, texts %q", title, count, tester.Texts())
	}
	if !tester.HasText("标签页 " + title) {
		t.Fatalf("the module page names itself in the tab bar, texts %q", tester.Texts())
	}
}

func TestTheWhiteboardTakesTheListBackgroundAndLiftsItsCards(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	row, ok := tester.Find("mygo")
	if !ok {
		t.Fatalf("the conversation list never rendered, texts %q", tester.Texts())
	}
	image := tester.Image()
	listBackground := image.RGBAAt(int(row.X+8), int(row.Y+row.H+8))
	distance := func(a, b color.RGBA) int {
		return absInt(int(a.R)-int(b.R)) + absInt(int(a.G)-int(b.G)) + absInt(int(a.B)-int(b.B))
	}
	tab, ok := tester.Find("标签页 白板")
	if !ok {
		t.Fatalf("the whiteboard tab never rendered, texts %q", tester.Texts())
	}
	card, ok := tester.Find(boardPanelTitle("context-overview") + "窗口")
	if !ok {
		t.Fatalf("the overview card never rendered, texts %q", tester.Texts())
	}
	canvas := image.RGBAAt(int(card.X+card.W/2), int(card.Y-5))
	if distance(canvas, listBackground) > 4 {
		t.Fatalf("the whiteboard background %v differs from the list background %v", canvas, listBackground)
	}
	tabBar := image.RGBAAt(int(tab.X+tab.W+24), int(tab.Y+tab.H/2))
	if distance(tabBar, listBackground) < 4 {
		t.Fatalf("the whiteboard tab bar took the list background %v", tabBar)
	}
	gap := image.RGBAAt(int(card.X+card.W+5), int(card.Y+card.H/2))
	if distance(gap, listBackground) < 4 {
		t.Fatalf("the cards cast no shadow over the canvas %v", gap)
	}
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func TestTheWhiteboardTabIsPinnedAlignedAndLarger(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	tab, ok := tester.Find("标签页 白板")
	if !ok {
		t.Fatalf("the whiteboard tab never rendered, texts %q", tester.Texts())
	}
	card, ok := tester.Find(boardPanelTitle("context-overview") + "窗口")
	if !ok {
		t.Fatalf("the whiteboard card never rendered, texts %q", tester.Texts())
	}
	if delta := tab.X - card.X; delta < -1 || delta > 1 {
		t.Fatalf("the tab starts at %v, the card at %v", tab.X, card.X)
	}
	title, ok := tester.Find("白板")
	if !ok {
		t.Fatalf("the tab title never rendered, texts %q", tester.Texts())
	}
	body, ok := tester.Find("来自主控")
	if !ok {
		t.Fatalf("the chat text never rendered, texts %q", tester.Texts())
	}
	if title.H <= body.H {
		t.Fatalf("the tab title is not larger: %v against %v", title.H, body.H)
	}
	if tester.HasText("关闭 白板") {
		t.Fatalf("the pinned tab offers a close button, texts %q", tester.Texts())
	}
	state.openModule("models")
	frames(tester)
	if len(state.board.pages) < 2 || state.board.pages[0].Title != "白板" || state.board.pages[0].Kind != "" {
		t.Fatalf("opening a module moved the pinned tab, pages %+v", state.board.pages)
	}
	state.closeBoardPage(0)
	if state.board.pages[0].Title != "白板" {
		t.Fatalf("the pinned tab closed, pages %+v", state.board.pages)
	}
}

func TestTheWhiteboardResetsFromItsTabMenu(t *testing.T) {
	state := fourPaneShell(t)
	state.board.pages[0].Panels = state.board.pages[0].Panels[:1]
	tester := frames(newTester(state.view, 1440, 900))
	if err := tester.RightClick("标签页 白板"); err != nil {
		t.Fatalf("open the tab menu: %v", err)
	}
	menu := tester.Menu()
	found := false
	for _, item := range menu {
		if item == "重置白板为默认初始状态" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the tab menu misses reset, menu %q", menu)
	}
	if err := tester.ChooseMenuItem("重置白板为默认初始状态"); err != nil {
		t.Fatalf("choose reset: %v", err)
	}
	frames(tester)
	if len(state.board.pages[0].Panels) != 3 {
		t.Fatalf("the board kept its panels, %+v", state.board.pages[0].Panels)
	}
}

func TestLoadingPinsTheWhiteboardFirstAndDropsExtraOnes(t *testing.T) {
	directory := t.TempDir()
	pages := []boardPage{
		{ID: "tab-models", Title: "模型配置", Kind: "models",
			Panels: []boardPanel{{ID: "models", Kind: "models"}},
			Layout: boardNode{Kind: "panel", PanelID: "models"}},
		{ID: "tab-two", Title: "白板 2", Panels: defaultBoardPanels(), Layout: defaultBoardLayout()},
		{ID: "tab-one", Title: "白板 1", Panels: defaultBoardPanels(), Layout: defaultBoardLayout()},
	}
	payload, err := json.Marshal(boardFile{Version: boardLayoutVersion, Pages: pages, Active: 0})
	if err != nil {
		t.Fatalf("encode the board: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "whiteboard.json"), payload, 0o600); err != nil {
		t.Fatalf("write the board: %v", err)
	}
	state := fourPaneShell(t)
	state.loadBoard(directory)
	if len(state.board.pages) != 2 {
		t.Fatalf("the extra whiteboards stayed, pages %+v", state.board.pages)
	}
	first := state.board.pages[0]
	if first.ID != "board" || first.Title != "白板" || first.Kind != "" {
		t.Fatalf("the whiteboard is not pinned first, page %+v", first)
	}
	if state.board.pages[1].Kind != "models" {
		t.Fatalf("modules keep their order after the whiteboard, pages %+v", state.board.pages)
	}
	if state.board.active != 1 {
		t.Fatalf("the active module page moved, active %d", state.board.active)
	}
}

func TestTheBoardTabBarHasNoBottomRule(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	tab, ok := tester.Find("标签页 白板")
	if !ok {
		t.Fatalf("the whiteboard tab never rendered, texts %q", tester.Texts())
	}
	image := tester.Image()
	x := int(tab.X + tab.W + 60)
	rule := image.RGBAAt(x, int(tab.Y+tab.H+2))
	background := image.RGBAAt(x, int(tab.Y+tab.H/2))
	delta := absInt(int(rule.R)-int(background.R)) + absInt(int(rule.G)-int(background.G)) + absInt(int(rule.B)-int(background.B))
	if delta > 4 {
		t.Fatalf("the tab bar keeps its bottom rule: %v against %v", rule, background)
	}
}

func TestTheBoardStacksTheContextOverviewAndTheNetwork(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(newTester(state.view, 1440, 900))
	rects := map[string]ui.Rect{}
	for _, kind := range []string{"context-overview", "agent-network", "fleet-collaboration"} {
		rect, ok := tester.Find(boardPanelTitle(kind) + "窗口")
		if !ok {
			t.Fatalf("%s never rendered, texts %q", kind, tester.Texts())
		}
		rects[kind] = rect
	}
	if tester.HasText("洞察概览窗口") {
		t.Fatalf("the insights card left the board, texts %q", tester.Texts())
	}
	overview, network := rects["context-overview"], rects["agent-network"]
	collaboration := rects["fleet-collaboration"]
	if overview.Y >= network.Y || network.Y >= collaboration.Y {
		t.Fatalf("the board stacks overview, network, then collaboration: %+v", rects)
	}
	if overview.W <= collaboration.W*0.9 || network.W <= collaboration.W*0.9 {
		t.Fatalf("every card takes the whole column, overview %.1f network %.1f collaboration %.1f", overview.W, network.W, collaboration.W)
	}
	if collaboration.Y+collaboration.H > 900 {
		t.Fatalf("the collaboration card runs past the window, %+v", collaboration)
	}
}

func TestTheAPIClientWaitsForLargeTrajectoryPayloads(t *testing.T) {
	if apiTimeout < 30*time.Second {
		t.Fatalf("the trajectory payloads need headroom, timeout %s", apiTimeout)
	}
}
