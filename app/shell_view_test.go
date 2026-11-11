package main

import (
	"image"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func fourPaneShell(t *testing.T) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[
				{"id":"g1","title":"Main","role":"global","archivedAt":null},
				{"id":"c1","title":"会话一","projectId":"13-Graph","role":"legacy","archivedAt":null},
				{"id":"c2","title":"会话二","projectId":"mygo","role":"legacy","archivedAt":null}
			]`))
		case "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话一"}],"tasks":[{"id":"t1","request":"实现四栏页面","status":"running","phase":"executing","nodes":[{"id":"planner","role":"worker","kind":"agent","status":"succeeded"},{"id":"worker","role":"worker","kind":"agent","status":"running"}]}]}`))
		case "/api/tasks/t1/graph":
			w.Write([]byte(`{"nodes":[{"id":"planner","kind":"agent","label":"planner","status":"succeeded"},{"id":"worker","kind":"agent","label":"worker","status":"running"}],"layout":{"positions":{"planner":{"x":40,"y":40,"width":160,"height":56},"worker":{"x":280,"y":170,"width":160,"height":56}},"edges":[{"id":"e1","source":"planner","target":"worker","points":[{"x":120,"y":96},{"x":120,"y":198},{"x":280,"y":198}]}]}}`))
		case "/api/conversations/c2":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话二"}]}`))
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
	conversation, ok := tester.Find("会话一")
	if !ok {
		t.Fatalf("the project conversation area must list conversations, texts %q", tester.Texts())
	}
	composer, ok := tester.Find("发送")
	if !ok {
		t.Fatalf("the chat pane must show its composer, texts %q", tester.Texts())
	}
	board, ok := tester.Find("网格")
	if !ok {
		t.Fatalf("the whiteboard must show its toolbar, texts %q", tester.Texts())
	}
	if !(rail.X < conversation.X && conversation.X+conversation.W <= composer.X && composer.X < board.X) {
		t.Fatalf("panes out of order: rail %+v conversation %+v composer %+v board %+v", rail, conversation, composer, board)
	}
	if !tester.HasText("项目概览") {
		t.Fatalf("the whiteboard must present the overview, texts %q", tester.Texts())
	}
	if !tester.HasText("来自会话一") {
		t.Fatalf("the chat pane must show the active conversation, texts %q", tester.Texts())
	}
	if !tester.HasText("main agent") {
		t.Fatalf("the conversation area must pin the main agent, texts %q", tester.Texts())
	}
}

func TestTheRailChoosesTheWhiteboardPanel(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if state.board.mode != boardHome {
		t.Fatalf("the window opens on the overview, mode %v", state.board.mode)
	}
	if err := tester.Click("图谱"); err != nil {
		t.Fatalf("click 图谱: %v", err)
	}
	frames(tester)
	if state.board.mode != boardGraph || !tester.HasText("图谱画布") {
		t.Fatalf("the rail must switch the whiteboard: mode %v texts %q", state.board.mode, tester.Texts())
	}
	if err := tester.Click("设置"); err != nil {
		t.Fatalf("click 设置: %v", err)
	}
	frames(tester)
	if state.board.mode != boardSettings || !tester.HasText("运行设置") {
		t.Fatalf("the rail must switch the whiteboard: mode %v texts %q", state.board.mode, tester.Texts())
	}
}

func TestTheBoardGridCanBeTurnedOff(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if !state.board.grid {
		t.Fatal("the whiteboard shows its dotted grid by default")
	}
	on := countColor(tester.Image(), boardDot)
	if on < 200 {
		t.Fatalf("the dotted grid must show, %d dots painted", on)
	}
	if err := tester.Click("网格"); err != nil {
		t.Fatalf("click 网格: %v", err)
	}
	frames(tester)
	if state.board.grid {
		t.Fatal("the toolbar must turn the grid off")
	}
	if off := countColor(tester.Image(), boardDot); off != 0 {
		t.Fatalf("turning the grid off must remove every dot, %d left", off)
	}
}

func TestTheComposerFitsTheMinimumWindow(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1024, 640))
	for _, label := range []string{"概览", "会话一", "发送", "网格"} {
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
	if countColor(tester.Image(), graphStatusSucceeded) == 0 {
		t.Fatal("the succeeded node must paint its status color")
	}
	if countColor(tester.Image(), graphStatusRunning) == 0 {
		t.Fatal("the running node must paint its status color")
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
