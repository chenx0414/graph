package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

var fleetPanelKinds = []string{
	"fleet-kpi",
	"fleet-network",
	"fleet-collaboration",
	"fleet-tasks",
	"fleet-events",
	"fleet-artifacts",
}

func TestTheRailOpensTheFleetPage(t *testing.T) {
	pages := defaultBoardPages()
	if len(pages) != 1 || pages[0].ID != "board" || pages[0].Kind != "" {
		t.Fatalf("the board starts with the whiteboard alone, pages %+v", pages)
	}
	state := newShellState("http://127.0.0.1:1", "tok")
	state.openModule("fleet")
	page := state.boardPage()
	if page.ID != "fleet" || page.Kind != "fleet" || page.Title != "编队" {
		t.Fatalf("the rail opens the fleet page, page %+v", page)
	}
	if len(page.Panels) != len(fleetPanelKinds) {
		t.Fatalf("the fleet page carries %d panels, want %d: %+v", len(page.Panels), len(fleetPanelKinds), page.Panels)
	}
	for index, kind := range fleetPanelKinds {
		wantKind := kind
		if kind == "fleet-network" {
			wantKind = "agent-network"
		}
		if page.Panels[index].ID != kind || page.Panels[index].Kind != wantKind {
			t.Fatalf("fleet panel %d is %+v, want kind %q", index, page.Panels[index], wantKind)
		}
	}
	state.openModule("fleet")
	if len(state.board.pages) != 2 {
		t.Fatalf("opening the rail twice reuses the page, pages %+v", state.board.pages)
	}
}

func TestTheFleetPageClosesLikeAnyModule(t *testing.T) {
	directory := t.TempDir()
	payload, err := json.Marshal(boardFile{
		Version: boardLayoutVersion,
		Pages:   []boardPage{{ID: "board", Title: boardDefaultTitle, Panels: defaultBoardPanels(), Layout: defaultBoardLayout()}},
	})
	if err != nil {
		t.Fatalf("encode the board: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "whiteboard.json"), payload, 0o600); err != nil {
		t.Fatalf("write the board: %v", err)
	}
	state := newShellState("http://127.0.0.1:1", "tok")
	state.loadBoard(directory)
	if len(state.board.pages) != 1 {
		t.Fatalf("a board without the fleet page keeps the whiteboard alone, pages %+v", state.board.pages)
	}
	state.openModule("fleet")
	if len(state.board.pages) != 2 || state.board.pages[1].ID != "fleet" {
		t.Fatalf("the rail adds the fleet page after the whiteboard, pages %+v", state.board.pages)
	}
	state.closeBoardPage(1)
	if len(state.board.pages) != 1 || state.activeBoardKind() != "" {
		t.Fatalf("the fleet page closes like a module, pages %+v", state.board.pages)
	}
	state.openModule("models")
	state.openModule("fleet")
	if len(state.board.pages) != 3 || state.board.pages[1].Kind != "models" || state.board.pages[2].ID != "fleet" {
		t.Fatalf("module pages keep their order, pages %+v", state.board.pages)
	}
}

func TestTheFleetTabLooksLikeTheWhiteboardAndCloses(t *testing.T) {
	state := newShellState("http://127.0.0.1:1", "tok")
	state.openModule("fleet")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	boardTab, ok := tester.Find("标签页 白板")
	if !ok {
		t.Fatalf("the whiteboard tab never rendered, texts %q", tester.Texts())
	}
	fleetTab, ok := tester.Find("标签页 编队")
	if !ok {
		t.Fatalf("the fleet tab never rendered, texts %q", tester.Texts())
	}
	if fleetTab.Y != boardTab.Y || fleetTab.H != boardTab.H {
		t.Fatalf("the fleet tab must keep the whiteboard band: fleet %+v board %+v", fleetTab, boardTab)
	}
	if fleetTab.X <= boardTab.X {
		t.Fatalf("the fleet tab must come after the whiteboard, fleet %+v board %+v", fleetTab, boardTab)
	}
	tester = frames(tester)
	if !tester.HasText("关闭 编队") {
		t.Fatalf("the fleet tab closes like a module, texts %q", tester.Texts())
	}
	if tester.HasText("新建标签页") || tester.HasText("添加") {
		t.Fatalf("the fleet page adds no plus entry, texts %q", tester.Texts())
	}
	state.openModule("models")
	tester = frames(tester)
	if !tester.HasText("关闭 模型配置") {
		t.Fatalf("module tabs must stay closable, texts %q", tester.Texts())
	}
}

const fleetSampleJSON = `{
  "rootId": "g1",
  "truncated": false,
  "stats": {"agents": 4, "running": 3, "tasks": 2, "messages": 42, "tokens": 120000, "cost": 1.25},
  "agents": [
    {"id":"g1","parentId":"","kind":"global","role":"lead","name":"主控","model":"deepseek-v4","projectId":"","conversationId":"g1","taskId":"","nodeId":"","status":"running","activity":"调度项目","tokens":24000,"cost":0.42,"requests":3,"messages":12,"createdAt":1,"updatedAt":2,"currentOperationId":"op-g1"},
    {"id":"p1","parentId":"g1","kind":"project","role":"lead","name":"13-Graph","model":"deepseek-v4","projectId":"13-Graph","conversationId":"p1","taskId":"","nodeId":"","status":"running","activity":"执行 work_request","tokens":40000,"cost":0.5,"requests":5,"messages":20,"createdAt":3,"updatedAt":4,"currentOperationId":"op-p1"},
    {"id":"n1","parentId":"p1","kind":"node","role":"worker","name":"planner","model":"deepseek-v4-flash","projectId":"13-Graph","conversationId":"p1","taskId":"t1","nodeId":"planner","status":"completed","activity":"整理规格","tokens":8000,"cost":0.12,"requests":2,"messages":4,"createdAt":5,"updatedAt":6,"currentOperationId":"op-n1"},
    {"id":"n2","parentId":"p1","kind":"node","role":"worker","name":"worker","model":"deepseek-v4-flash","projectId":"13-Graph","conversationId":"p1","taskId":"t1","nodeId":"worker","status":"running","activity":"实现白板页","tokens":16000,"cost":0.21,"requests":4,"messages":6,"createdAt":7,"updatedAt":8,"currentOperationId":"op-n2"}
  ],
  "links": [
    {"from":"g1","to":"p1","kind":"parent"},
    {"from":"p1","to":"n1","kind":"parent"},
    {"from":"p1","to":"n2","kind":"parent"}
  ],
  "tasks": [
    {"id":"t1","title":"实现四栏页面","status":"running","phase":"executing","ownerAgentId":"p1","projectId":"13-Graph","taskId":"t1","nodeId":"","startedAt":11,"updatedAt":12},
    {"id":"wr-1","title":"补充编队测试","status":"pending","phase":"queued","ownerAgentId":"n1","projectId":"13-Graph","taskId":"","nodeId":"","startedAt":13,"updatedAt":14}
  ],
  "events": [
    {"id":"1","at":1700000000000,"type":"link.delegation","agentId":"g1","targetAgentId":"p1","text":"委派 实现四栏页面"},
    {"id":"2","at":1700000001000,"type":"about.result","agentId":"p1","targetAgentId":"g1","text":"返回执行结果"},
    {"id":"3","at":1700000002000,"type":"link.delivery","agentId":"n1","targetAgentId":"n2","text":"planner 投递 交接说明"}
  ],
  "artifacts": [
    {"artifactId":"a1","taskId":"t1","namespace":"docs","name":"spec.md","title":"规格","mediaType":"text/markdown","version":2,"size":2048,"producerAgentId":"p1","producerTaskId":"t1","createdAt":21}
  ]
}`

func fleetServerShell(t *testing.T, fleet http.HandlerFunc) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/conversations":
			_, _ = w.Write([]byte(`[
				{"id":"g1","title":"Main","role":"global","archivedAt":null},
				{"id":"p1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null}
			]`))
		case r.URL.Path == "/api/conversations/g1":
			_, _ = w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自主控"}]}`))
		case r.URL.Path == "/api/conversations/p1":
			_, _ = w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话一"}]}`))
		case r.URL.Path == "/api/fleet":
			fleet(w, r)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	state := newShellState(server.URL, "tok")
	state.load()
	return state
}

func fleetSampleServer(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte(fleetSampleJSON))
}

func openFleetTester(t *testing.T, state *shellState) *ui.Tester {
	t.Helper()
	state.openModule("fleet")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for state.fleet.data == nil && state.fleet.failed == "" {
		if !time.Now().Before(deadline) {
			t.Fatalf("the fleet data never landed, texts %q", tester.Texts())
		}
		tester.Frame()
	}
	return frames(tester)
}

func TestTheFleetPageUsesItsDashboardLayout(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	rects := map[string]ui.Rect{}
	for _, kind := range fleetPanelKinds {
		rect, ok := tester.Find(boardPanelTitle(kind) + "窗口")
		if !ok {
			t.Fatalf("the fleet page misses the %s panel, texts %q", kind, tester.Texts())
		}
		rects[kind] = rect
	}
	kpi := rects["fleet-kpi"]
	network := rects["fleet-network"]
	collaboration := rects["fleet-collaboration"]
	tasks := rects["fleet-tasks"]
	events := rects["fleet-events"]
	artifacts := rects["fleet-artifacts"]
	if delta := kpi.X - network.X; delta < -1 || delta > 1 {
		t.Fatalf("the KPI strip starts where the dashboard starts: kpi %+v network %+v", kpi, network)
	}
	if delta := (kpi.X + kpi.W) - (artifacts.X + artifacts.W); delta < -2 || delta > 2 {
		t.Fatalf("the KPI strip spans the dashboard: kpi %+v artifacts %+v", kpi, artifacts)
	}
	if kpi.H < 108 || kpi.H > 132 {
		t.Fatalf("the KPI strip keeps its own band, height %.1f", kpi.H)
	}
	if kpi.Y+kpi.H > network.Y {
		t.Fatalf("the KPI strip sits above the rest: kpi %+v network %+v", kpi, network)
	}
	if network.W <= collaboration.W {
		t.Fatalf("the agent network takes the wide column: network %+v collaboration %+v", network, collaboration)
	}
	if collaboration.X < network.X+network.W-1 {
		t.Fatalf("the network and the right column split one row: network %+v collaboration %+v", network, collaboration)
	}
	if tasks.X != collaboration.X || tasks.Y <= collaboration.Y || tasks.Y < collaboration.Y+collaboration.H-1 {
		t.Fatalf("the right column stacks collaboration over tasks: collaboration %+v tasks %+v", collaboration, tasks)
	}
	if events.Y < network.Y+network.H-1 {
		t.Fatalf("the event check starts under the second row: events %+v network %+v", events, network)
	}
	if artifacts.Y < events.Y || artifacts.X < events.X+events.W-1 {
		t.Fatalf("the third row pairs events with artifacts: events %+v artifacts %+v", events, artifacts)
	}
	if events.W <= artifacts.W {
		t.Fatalf("the event check takes the wide column: events %+v artifacts %+v", events, artifacts)
	}
}
