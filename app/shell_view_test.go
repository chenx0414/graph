package main

import (
	"encoding/json"
	"image"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

func fourPaneShell(t *testing.T) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[
				{"id":"g1","title":"Main","role":"global","archivedAt":null},
				{"id":"p1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null},
				{"id":"p2","title":"mygo","projectId":"mygo","role":"project","archivedAt":null},
				{"id":"old1","title":"旧聊天","projectId":"13-Graph","role":"legacy","archivedAt":null}
			]`))
		case "/api/conversations/g1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自主控"}],"tasks":[{"id":"t1","request":"实现四栏页面","status":"running","phase":"executing","nodes":[{"id":"planner","role":"worker","kind":"agent","status":"succeeded"},{"id":"worker","role":"worker","kind":"agent","status":"running"}]}]}`))
		case "/api/conversations/p1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话一"}],"tasks":[{"id":"t1","request":"实现四栏页面","status":"running","phase":"executing","nodes":[{"id":"planner","role":"worker","kind":"agent","status":"succeeded"},{"id":"worker","role":"worker","kind":"agent","status":"running"}]}]}`))
		case "/api/conversations/p2":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话二"}]}`))
		case "/api/tasks/t1/graph":
			w.Write([]byte(`{"nodes":[{"id":"planner","kind":"agent","label":"planner","status":"succeeded"},{"id":"worker","kind":"agent","label":"worker","status":"running"}],"layout":{"positions":{"planner":{"x":40,"y":40,"width":160,"height":56},"worker":{"x":280,"y":170,"width":160,"height":56}},"edges":[{"id":"e1","source":"planner","target":"worker","points":[{"x":120,"y":96},{"x":120,"y":198},{"x":280,"y":198}]}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	state := newShellState(server.URL, "tok")
	state.load()
	return state
}

func frames(tester *ui.Tester) *ui.Tester {
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	return tester
}

func TestTheWindowShowsFourPanesLeftToRight(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))

	rail, ok := tester.Find("概览")
	if !ok {
		t.Fatalf("the function rail must show its home entry, texts %q", tester.Texts())
	}
	conversation, ok := tester.Find("13-Graph")
	if !ok {
		t.Fatalf("the project conversation area must list the project, texts %q", tester.Texts())
	}
	composer, ok := tester.Find("发送")
	if !ok {
		t.Fatalf("the chat pane must show its composer, texts %q", tester.Texts())
	}
	board, ok := tester.Find("白板")
	if !ok {
		t.Fatalf("the whiteboard must show its tabs, texts %q", tester.Texts())
	}
	if !(rail.X < conversation.X && conversation.X+conversation.W <= composer.X && composer.X < board.X) {
		t.Fatalf("panes out of order: rail %+v conversation %+v composer %+v board %+v", rail, conversation, composer, board)
	}
	if !tester.HasText("项目概览") {
		t.Fatalf("the whiteboard must present the overview module, texts %q", tester.Texts())
	}
	if !tester.HasText("来自主控") {
		t.Fatalf("the chat pane must open the main agent conversation, texts %q", tester.Texts())
	}
	if !tester.HasText("main agent") {
		t.Fatalf("the conversation area must pin the main agent, texts %q", tester.Texts())
	}
	if tester.HasText("旧聊天") {
		t.Fatalf("a legacy chat must stay out of the project conversation list, texts %q", tester.Texts())
	}
}

func TestTheMainAgentRowStandsOutFromTheProjects(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if !tester.HasText("main agent") {
		t.Fatalf("the main agent row must read as the agent, texts %q", tester.Texts())
	}
	for _, text := range tester.Texts() {
		if text == "主控 · 常驻" {
			t.Fatalf("the main agent row must carry no caption, texts %q", tester.Texts())
		}
	}
	if ink := countColor(tester.Image(), gwtheme.Light().Foreground); ink < 100 {
		t.Fatalf("the octopus must be drawn in theme ink, %d ink pixels", ink)
	}
	if violet := countColor(tester.Image(), palette.Violet100.Color()); violet != 0 {
		t.Fatalf("the octopus is monochrome now, %d violet pixels", violet)
	}
	if dot := countColor(tester.Image(), gwtheme.Light().Success); dot != 0 {
		t.Fatalf("the main agent row carries no status dot, %d green pixels", dot)
	}
}

func TestTheAppFocusesTheComposerOnOpen(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	tester.Type("你好")
	frames(tester)
	active := state.active()
	if active == nil || active.draft != "你好" {
		t.Fatalf("the composer must be focused when the app opens, active %v", active)
	}
}

func TestTheRailOpensATabForTheModule(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.Click("图谱"); err != nil {
		t.Fatalf("click 图谱: %v", err)
	}
	frames(tester)
	if kind := state.activeBoardKind(); kind != "graph" || !tester.HasText("图谱画布") {
		t.Fatalf("the rail must open the graph tab: kind %q texts %q", kind, tester.Texts())
	}
	if err := tester.Click("设置"); err != nil {
		t.Fatalf("click 设置: %v", err)
	}
	frames(tester)
	if kind := state.activeBoardKind(); kind != "settings" || !tester.HasText("运行设置") {
		t.Fatalf("the rail must open the settings tab: kind %q texts %q", kind, tester.Texts())
	}
	if err := tester.Click("白板"); err != nil {
		t.Fatalf("click the board tab: %v", err)
	}
	frames(tester)
	if kind := state.activeBoardKind(); kind != "" || !tester.HasText("项目概览") {
		t.Fatalf("the board tab must come back: kind %q texts %q", kind, tester.Texts())
	}
}

func TestTheShellFloatsOnAShadow(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	img := tester.Image()
	luminance := func(x, y int) int {
		at := img.PixOffset(x, y)
		return (int(img.Pix[at]) + int(img.Pix[at+1]) + int(img.Pix[at+2])) / 3
	}
	backdrop := luminance(4, 450)
	belowCard := luminance(700, 894)
	if belowCard >= backdrop-4 {
		t.Fatalf("the shell drops a shadow on the backdrop, backdrop %d below %d", backdrop, belowCard)
	}
	send, ok := tester.Find("发送")
	if !ok {
		t.Fatalf("the composer never rendered, texts %q", tester.Texts())
	}
	composerBottom := int(send.Y+send.H) + 15
	composerShadow := luminance(int(send.X+send.W/2), composerBottom)
	if composerShadow >= 250 {
		t.Fatalf("the composer sits above the chat with its own shadow, %d at y %d", composerShadow, composerBottom)
	}
}

func TestTheConversationHeaderStaysQuiet(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	countHeader := regexp.MustCompile(`^[0-9]+ 个会话$`)
	for _, text := range tester.Texts() {
		if countHeader.MatchString(text) {
			t.Fatalf("the conversation list header carries no count, texts %q", tester.Texts())
		}
	}
}

func TestTheThreeColumnsShareOneShellBand(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	listTitle, ok := tester.Find("会话列表标题")
	if !ok {
		t.Fatalf("the conversation list header never rendered, texts %q", tester.Texts())
	}
	chatTitle, ok := tester.Find("对话标题")
	if !ok {
		t.Fatalf("the chat header never rendered, texts %q", tester.Texts())
	}
	boardTitle, ok := tester.Find("白板标题")
	if !ok {
		t.Fatalf("the board header never rendered, texts %q", tester.Texts())
	}
	for name, rect := range map[string]ui.Rect{"list": listTitle, "chat": chatTitle, "board": boardTitle} {
		if rect.Y != listTitle.Y || rect.H != listTitle.H {
			t.Fatalf("every column header shares one band: %s %+v vs list %+v", name, rect, listTitle)
		}
	}
	if !(listTitle.X < chatTitle.X && chatTitle.X < boardTitle.X) {
		t.Fatalf("the columns line up left to right: list %+v chat %+v board %+v", listTitle, chatTitle, boardTitle)
	}
}

func TestTheWhiteboardHasTabsAndNoFloatingToolbar(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	for _, gone := range []string{"添加", "搜索", "网格", "聚焦", "重置"} {
		if tester.HasText(gone) {
			t.Fatalf("the floating toolbar is gone, %q still shows, texts %q", gone, tester.Texts())
		}
	}
	if !tester.HasText("白板") || !tester.HasText("新建标签页") {
		t.Fatalf("the board offers its tab bar, texts %q", tester.Texts())
	}
	if err := tester.Click("新建标签页"); err != nil {
		t.Fatalf("open a tab: %v", err)
	}
	frames(tester)
	if len(state.board.pages) != 2 || state.board.active != 1 {
		t.Fatalf("a new tab joins the bar, pages %d active %d", len(state.board.pages), state.board.active)
	}
}

func TestTheComposerFitsTheMinimumWindow(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1024, 640))
	for _, label := range []string{"概览", "13-Graph", "发送", "白板"} {
		rect, ok := tester.Find(label)
		if !ok {
			t.Fatalf("%s never rendered, texts %q", label, tester.Texts())
		}
		if rect.X < 0 || rect.Y < 0 || rect.X+rect.W > 1024 || rect.Y+rect.H > 640 {
			t.Fatalf("%s sits outside the window: %+v", label, rect)
		}
	}
}

func TestTheOverviewPresentsStats(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	for _, label := range []string{"会话", "项目", "用量", "能力库"} {
		if !tester.HasText(label) {
			t.Fatalf("the overview must present %q, texts %q", label, tester.Texts())
		}
	}
}

func TestTheGraphPanelDrawsTheTaskGraph(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.Click("图谱"); err != nil {
		t.Fatalf("click 图谱: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.active() == nil || len(state.active().graph.nodes) == 0 {
		if !time.Now().Before(deadline) {
			t.Fatalf("the graph did not load, texts %q", tester.Texts())
		}
		time.Sleep(time.Millisecond)
	}
	tester = frames(tester)
	if graph := state.active().graph; len(graph.nodes) != 2 || len(graph.edges) != 1 {
		t.Fatalf("graph %+v", graph)
	}
	if !tester.HasText("2 个节点 · 1 条连接") {
		t.Fatalf("the graph panel must caption the graph, texts %q", tester.Texts())
	}
	if countColor(tester.Image(), gwtheme.Light().Success) == 0 {
		t.Fatal("the succeeded node must paint its status color")
	}
	if countColor(tester.Image(), gwtheme.Light().Unread) == 0 {
		t.Fatal("the running node must paint its status color")
	}
}

func TestTabsSwitchAndCloseWithoutLosingTheBoard(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.Click("图谱"); err != nil {
		t.Fatalf("open the graph tab: %v", err)
	}
	frames(tester)
	if err := tester.Click("图谱"); err != nil {
		t.Fatalf("reopen the graph tab: %v", err)
	}
	frames(tester)
	if len(state.board.pages) != 2 {
		t.Fatalf("one rail entry owns one tab, pages %d", len(state.board.pages))
	}
	if err := tester.Click("关闭 图谱画布"); err != nil {
		t.Fatalf("close the graph tab: %v", err)
	}
	frames(tester)
	if len(state.board.pages) != 1 || state.activeBoardKind() != "" {
		t.Fatalf("closing a tab returns to the board, pages %d kind %q", len(state.board.pages), state.activeBoardKind())
	}
	if !tester.HasText("项目概览") {
		t.Fatalf("the board comes back with its modules, texts %q", tester.Texts())
	}
}

func TestTheBoardKeepsFixedNonOverlappingPartitions(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	rects := map[string]ui.Rect{}
	for _, kind := range []string{"overview", "tasks", "history", "artifacts"} {
		rect, ok := tester.Find(boardPanelTitle(kind) + "窗口")
		if !ok {
			t.Fatalf("%s never rendered, texts %q", kind, tester.Texts())
		}
		rects[kind] = rect
	}
	names := []string{"overview", "tasks", "history", "artifacts"}
	for first := 0; first < len(names); first++ {
		for second := first + 1; second < len(names); second++ {
			a, b := rects[names[first]], rects[names[second]]
			if a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H {
				t.Fatalf("panes must not overlap: %s %+v vs %s %+v", names[first], a, names[second], b)
			}
		}
	}
	if rects["overview"].X != rects["history"].X || rects["tasks"].X != rects["artifacts"].X {
		t.Fatalf("the board keeps two fixed columns: %+v", rects)
	}
	if rects["overview"].Y != rects["tasks"].Y || rects["history"].Y != rects["artifacts"].Y {
		t.Fatalf("the board keeps fixed rows: %+v", rects)
	}
}

func TestDraggingAPanelBodySwapsItsPartition(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	overview := state.board.rects["overview"]
	tasks := state.board.rects["tasks"]
	if overview.W <= 0 || tasks.W <= 0 {
		t.Fatalf("the board must know its partitions, rects %+v", state.board.rects)
	}
	startX, startY := overview.X+overview.W/2, overview.Y+overview.H*0.6
	endX, endY := tasks.X+tasks.W/2, tasks.Y+tasks.H*0.6
	tester.Press(startX, startY)
	for step := 1; step <= 12; step++ {
		tester.Move(startX+(endX-startX)*float32(step)/12, startY+(endY-startY)*float32(step)/12)
		tester.Frame()
	}
	tester.Release(endX, endY)
	frames(tester)
	page := state.boardPage()
	if leaves := boardLeafIDs(&page.Layout); len(leaves) != 4 || leaves[0] != "tasks" || leaves[1] != "overview" {
		t.Fatalf("a center drop swaps the two partitions, leaves %v", leaves)
	}
}

func TestDraggingToAPartitionEdgeSplitsIt(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	overview := state.board.rects["overview"]
	tasks := state.board.rects["tasks"]
	if overview.W <= 0 || tasks.W <= 0 {
		t.Fatalf("the board must know its partitions, rects %+v", state.board.rects)
	}
	startX, startY := overview.X+overview.W/2, overview.Y+overview.H*0.6
	endX, endY := tasks.X+8, tasks.Y+tasks.H/2
	tester.Press(startX, startY)
	for step := 1; step <= 12; step++ {
		tester.Move(startX+(endX-startX)*float32(step)/12, startY+(endY-startY)*float32(step)/12)
		tester.Frame()
	}
	tester.Release(endX, endY)
	frames(tester)
	page := state.boardPage()
	leaves := boardLeafIDs(&page.Layout)
	if len(leaves) != 4 {
		t.Fatalf("a split keeps every module on the board, leaves %v", leaves)
	}
	seen := map[string]bool{}
	for _, id := range leaves {
		if seen[id] {
			t.Fatalf("a module appears twice after the split, leaves %v", leaves)
		}
		seen[id] = true
	}
	after := state.board.rects
	if after["overview"].X >= after["tasks"].X {
		t.Fatalf("dropping on the left edge puts the dragged pane before the target: overview %+v tasks %+v", after["overview"], after["tasks"])
	}
}

func TestADividerDragResizesBothPartitions(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	divider, ok := tester.Find("调整分区")
	if !ok {
		t.Fatalf("the split divider never rendered, texts %q", tester.Texts())
	}
	overviewBefore, _ := tester.Find(boardPanelTitle("overview") + "窗口")
	x, y := divider.X+divider.W/2, divider.Y+divider.H/2
	tester.Press(x, y)
	for step := 1; step <= 10; step++ {
		tester.Move(x+float32(step)*8, y)
		tester.Frame()
	}
	tester.Release(x+80, y)
	frames(tester)
	overviewAfter, _ := tester.Find(boardPanelTitle("overview") + "窗口")
	if overviewAfter.W <= overviewBefore.W {
		t.Fatalf("dragging the divider right must widen the left partition: before %.1f after %.1f", overviewBefore.W, overviewAfter.W)
	}
}

func TestAnOldFreeformBoardMigratesIntoPartitions(t *testing.T) {
	directory := t.TempDir()
	legacy := `{"version":3,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"overview","kind":"overview","slot":0},
		{"id":"tasks","kind":"tasks","slot":1}
	]}]}`
	if err := os.WriteFile(filepath.Join(directory, "whiteboard.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	state := newShellState("http://127.0.0.1:1", "tok")
	state.loadBoard(directory)
	page := state.boardPage()
	if leaves := boardLeafIDs(&page.Layout); len(leaves) != 2 || leaves[0] != "overview" || leaves[1] != "tasks" {
		t.Fatalf("a freeform board migrates into a partition tree, leaves %v", leaves)
	}
	if page.Kind != "" {
		t.Fatalf("the migrated page stays a board, kind %q", page.Kind)
	}
}

func TestTheBoardRemembersItsLayout(t *testing.T) {
	directory := t.TempDir()
	first := newShellState("http://127.0.0.1:1", "tok")
	first.loadBoard(directory)
	swapBoardPanels(&first.boardPage().Layout, "overview", "tasks")
	first.saveBoard()

	second := newShellState("http://127.0.0.1:1", "tok")
	second.loadBoard(directory)
	leaves := boardLeafIDs(&second.boardPage().Layout)
	if len(leaves) != 4 || leaves[0] != "tasks" || leaves[1] != "overview" {
		t.Fatalf("saved partitions not restored: leaves %v", leaves)
	}
}

func countColor(img *image.RGBA, want ui.Color) int {
	count := 0
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
			at := img.PixOffset(x, y)
			if img.Pix[at] == want.R && img.Pix[at+1] == want.G && img.Pix[at+2] == want.B && img.Pix[at+3] == want.A {
				count++
			}
		}
	}
	return count
}

func TestTheRailNoLongerOffersHistoryOrConversationPages(t *testing.T) {
	for _, item := range railItems {
		if item.kind == "history" || item.kind == "conversation" {
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
	frames(ui.NewTester(state.view, 1440, 900))
}
