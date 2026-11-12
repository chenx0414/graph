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

func TestTheBoardShowsTheTrajectoryAndInsightsCards(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	for _, label := range []string{"轨迹量化窗口", "洞察概览窗口"} {
		if !tester.HasText(label) {
			t.Fatalf("the default board must present %q, texts %q", label, tester.Texts())
		}
	}
}

func TestTheBoardKeepsFixedNonOverlappingPartitions(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	rects := map[string]ui.Rect{}
	for _, kind := range []string{"tasks", "artifacts", "trajectory", "insights"} {
		rect, ok := tester.Find(boardPanelTitle(kind) + "窗口")
		if !ok {
			t.Fatalf("%s never rendered, texts %q", kind, tester.Texts())
		}
		rects[kind] = rect
	}
	names := []string{"tasks", "artifacts", "trajectory", "insights"}
	for first := 0; first < len(names); first++ {
		for second := first + 1; second < len(names); second++ {
			a, b := rects[names[first]], rects[names[second]]
			if a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H {
				t.Fatalf("panes must not overlap: %s %+v vs %s %+v", names[first], a, names[second], b)
			}
		}
	}
	if rects["tasks"].Y != rects["artifacts"].Y || rects["trajectory"].Y != rects["insights"].Y {
		t.Fatalf("the board keeps two fixed rows: %+v", rects)
	}
	if rects["trajectory"].Y <= rects["tasks"].Y {
		t.Fatalf("trajectory and insights sit below tasks: %+v", rects)
	}
	if rects["tasks"].X != rects["trajectory"].X || rects["artifacts"].X != rects["insights"].X {
		t.Fatalf("the board keeps two fixed columns: %+v", rects)
	}
}

func TestDraggingAPanelBodySwapsItsPartition(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	tasks := state.board.rects["tasks"]
	artifacts := state.board.rects["artifacts"]
	if tasks.W <= 0 || artifacts.W <= 0 {
		t.Fatalf("the board must know its partitions, rects %+v", state.board.rects)
	}
	startX, startY := tasks.X+tasks.W/2, tasks.Y+tasks.H*0.6
	endX, endY := artifacts.X+artifacts.W/2, artifacts.Y+artifacts.H*0.6
	tester.Press(startX, startY)
	for step := 1; step <= 12; step++ {
		tester.Move(startX+(endX-startX)*float32(step)/12, startY+(endY-startY)*float32(step)/12)
		tester.Frame()
	}
	tester.Release(endX, endY)
	frames(tester)
	page := state.boardPage()
	if leaves := boardLeafIDs(&page.Layout); len(leaves) != 4 || leaves[0] != "artifacts" || leaves[1] != "tasks" || leaves[2] != "trajectory" || leaves[3] != "insights" {
		t.Fatalf("a center drop swaps the two partitions, leaves %v", leaves)
	}
}

func TestDraggingToAPartitionEdgeSplitsIt(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	tasks := state.board.rects["tasks"]
	artifacts := state.board.rects["artifacts"]
	if tasks.W <= 0 || artifacts.W <= 0 {
		t.Fatalf("the board must know its partitions, rects %+v", state.board.rects)
	}
	startX, startY := tasks.X+tasks.W/2, tasks.Y+tasks.H*0.6
	endX, endY := artifacts.X+8, artifacts.Y+artifacts.H/2
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
	if after["tasks"].X >= after["artifacts"].X {
		t.Fatalf("dropping on the left edge puts the dragged pane before the target: tasks %+v artifacts %+v", after["tasks"], after["artifacts"])
	}
}

func TestADividerDragResizesBothPartitions(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	divider, ok := tester.Find("调整分区")
	if !ok {
		t.Fatalf("the split divider never rendered, texts %q", tester.Texts())
	}
	tasksBefore, _ := tester.Find(boardPanelTitle("tasks") + "窗口")
	x, y := divider.X+divider.W/2, divider.Y+divider.H/2
	tester.Press(x, y)
	for step := 1; step <= 10; step++ {
		tester.Move(x+float32(step)*8, y)
		tester.Frame()
	}
	tester.Release(x+80, y)
	frames(tester)
	tasksAfter, _ := tester.Find(boardPanelTitle("tasks") + "窗口")
	if tasksAfter.W <= tasksBefore.W {
		t.Fatalf("dragging the divider right must widen the left partition: before %.1f after %.1f", tasksBefore.W, tasksAfter.W)
	}
}

func TestAnOldFreeformBoardMigratesIntoPartitions(t *testing.T) {
	directory := t.TempDir()
	legacy := `{"version":3,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"tasks","kind":"tasks","slot":0},
		{"id":"artifacts","kind":"artifacts","slot":1}
	]}]}`
	if err := os.WriteFile(filepath.Join(directory, "whiteboard.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	state := newShellState("http://127.0.0.1:1", "tok")
	state.loadBoard(directory)
	page := state.boardPage()
	if leaves := boardLeafIDs(&page.Layout); len(leaves) != 4 || leaves[0] != "tasks" || leaves[1] != "artifacts" {
		t.Fatalf("a freeform board migrates into a partition tree and gains the dashboard cards, leaves %v", leaves)
	}
	if page.Kind != "" {
		t.Fatalf("the migrated page stays a board, kind %q", page.Kind)
	}
}

func TestTheBoardRemembersItsLayout(t *testing.T) {
	directory := t.TempDir()
	first := newShellState("http://127.0.0.1:1", "tok")
	first.loadBoard(directory)
	swapBoardPanels(&first.boardPage().Layout, "tasks", "artifacts")
	first.saveBoard()

	second := newShellState("http://127.0.0.1:1", "tok")
	second.loadBoard(directory)
	leaves := boardLeafIDs(&second.boardPage().Layout)
	if len(leaves) != 4 || leaves[0] != "artifacts" || leaves[1] != "tasks" {
		t.Fatalf("saved partitions not restored: leaves %v", leaves)
	}
}

func TestTheRailNoLongerOffersHistoryOrConversationPages(t *testing.T) {
	for _, item := range railItems {
		if item.kind == "history" || item.kind == "conversation" || item.kind == "overview" {
			t.Fatalf("the rail still offers %q", item.kind)
		}
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
		if panel.Kind == "history" || panel.Kind == "conversation" {
			t.Fatalf("removed panel survived, panels %+v", state.board.pages[0].Panels)
		}
	}
	for _, id := range boardLeafIDs(&state.board.pages[0].Layout) {
		if id == "history" || id == "conversation" {
			t.Fatalf("removed panel leaf survived, leaves %v", boardLeafIDs(&state.board.pages[0].Layout))
		}
	}
	frames(ui.NewTester(state.view, 1440, 900))
}

func TestLoadingAnOldBoardAddsTheTrajectoryAndInsightsCards(t *testing.T) {
	state := fourPaneShell(t)
	dir := t.TempDir()
	legacy := `{"version":4,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"tasks","kind":"tasks","slot":0},
		{"id":"artifacts","kind":"artifacts","slot":1},
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
	if kinds["overview"] || !kinds["trajectory"] || !kinds["insights"] {
		t.Fatalf("the old board must trade overview for trajectory and insights, panels %+v", page.Panels)
	}
}

func TestTheWhiteboardHeaderSlidesOverItsContentWithoutMovingIt(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	card, ok := tester.Find(boardPanelTitle("tasks") + "窗口")
	if !ok {
		t.Fatalf("the tasks card never rendered, texts %q", tester.Texts())
	}
	content, ok := tester.Find("实现四栏页面 · running · executing")
	if !ok {
		t.Fatalf("the task row never rendered, texts %q", tester.Texts())
	}
	open, ok := tester.Find("在新标签页打开")
	if !ok {
		t.Fatalf("the card header never rendered, texts %q", tester.Texts())
	}
	_ = open
	tester.Move(card.X+card.W/2, card.Y+card.H/2)
	tester.Advance(300 * time.Millisecond)
	frames(tester)
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
	tester := frames(ui.NewTester(state.view, 1440, 900))
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

func TestAModulePageShowsItsCardHeaderWithoutHover(t *testing.T) {
	state := fourPaneShell(t)
	state.board.pages = []boardPage{{ID: "board", Title: boardDefaultTitle, Kind: "models",
		Panels: []boardPanel{{ID: "models", Kind: "models"}},
		Layout: boardNode{Kind: "panel", PanelID: "models"}}}

	tester := frames(ui.NewTester(state.view, 1440, 900))
	card, ok := tester.Find(boardPanelTitle("models") + "窗口")
	if !ok {
		t.Fatalf("the models card never rendered, texts %q", tester.Texts())
	}
	title, ok := tester.Find(boardPanelTitle("models"))
	if !ok {
		t.Fatalf("the module page hid its card header, texts %q", tester.Texts())
	}
	if title.Y < card.Y || title.Y >= card.Y+40 {
		t.Fatalf("the module page header sits at %v, card at %v", title.Y, card.Y)
	}
}

func TestTheWhiteboardTakesTheListBackgroundAndLiftsItsCards(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
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
	card, ok := tester.Find(boardPanelTitle("tasks") + "窗口")
	if !ok {
		t.Fatalf("the tasks card never rendered, texts %q", tester.Texts())
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
	tester := frames(ui.NewTester(state.view, 1440, 900))
	tab, ok := tester.Find("标签页 白板")
	if !ok {
		t.Fatalf("the whiteboard tab never rendered, texts %q", tester.Texts())
	}
	card, ok := tester.Find(boardPanelTitle("tasks") + "窗口")
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
	tester := frames(ui.NewTester(state.view, 1440, 900))
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
	if len(state.board.pages[0].Panels) != 4 {
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
	if state.board.active != 1 {
		t.Fatalf("the active module page moved, active %d", state.board.active)
	}
}

func TestTheBoardTabBarHasNoBottomRule(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	tab, ok := tester.Find("标签页 白板")
	if !ok {
		t.Fatalf("the whiteboard tab never rendered, texts %q", tester.Texts())
	}
	image := tester.Image()
	x := int(tab.X + tab.W + 60)
	rule := image.RGBAAt(x, int(tab.Y+tab.H+4))
	background := image.RGBAAt(x, int(tab.Y+tab.H/2))
	delta := absInt(int(rule.R)-int(background.R)) + absInt(int(rule.G)-int(background.G)) + absInt(int(rule.B)-int(background.B))
	if delta > 4 {
		t.Fatalf("the tab bar keeps its bottom rule: %v against %v", rule, background)
	}
}
