package main

import (
	"os"
	"path/filepath"
	"testing"
)

func networkPanelFleet() *fleetSnapshot {
	data := &fleetSnapshot{RootID: "g1"}
	data.Agents = []fleetAgent{
		{ID: "g1", Kind: "global", Role: "lead", Name: "Main", Status: "running", ConversationID: "g1"},
		{ID: "p1", ParentID: "g1", Kind: "project", Role: "lead", Name: "项目 A", Status: "running", ConversationID: "p1"},
		{ID: "p2", ParentID: "g1", Kind: "project", Role: "lead", Name: "项目 B", Status: "idle", ConversationID: "p2"},
		{ID: "p1-n1", ParentID: "p1", Kind: "node", Role: "worker", Name: "planner", Status: "running", TaskID: "tA", NodeID: "n2"},
	}
	data.Tasks = []fleetTask{{TaskID: "tA", ID: "tA", Title: "目标：验证编队网络", Status: "running", Phase: "executing", OwnerAgentID: "p1"}}
	return data
}

func TestTheWhiteboardNetworkShowsThreadsForMain(t *testing.T) {
	mock := &nodeChatMock{
		fleet: networkPanelFleet(),
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("g1")
	tester = frames(frames(tester))
	if !tester.HasText("编队 · Main 中心 · Thread 环 · 拖拽平移 · 滚轮缩放") {
		t.Fatalf("the network panel is the fleet network around Main, texts %q", tester.Texts())
	}
	if !tester.HasText("编队 Agent 项目 A") || !tester.HasText("编队 Agent 项目 B") {
		t.Fatalf("the network panel shows the thread agents, texts %q", tester.Texts())
	}
}

func TestTheWhiteboardNetworkShowsGraphsForAThread(t *testing.T) {
	mock := &nodeChatMock{
		fleet: networkPanelFleet(),
		conv: map[string]string{
			"p1": `{"messages":[{"id":"m2","seq":1,"role":"assistant","kind":"message","text":"项目线程","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("p1")
	tester = frames(frames(tester))
	if !tester.HasText("线程 · Graph 环 · 拖拽平移 · 滚轮缩放") {
		t.Fatalf("the network panel shows the thread's graphs, texts %q", tester.Texts())
	}
	if !tester.HasText("目标：验证编队网络") {
		t.Fatalf("the network panel names the graph unit, texts %q", tester.Texts())
	}
}

func TestTheWhiteboardNetworkShowsTheGraphForAGraphAgent(t *testing.T) {
	fleet := networkPanelFleet()
	node := fleetAgent{ID: "p1-n1", ParentID: "p1", Kind: "node", Name: "planner", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet:    fleet,
		run:      `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点在干活","createdAt":1}],"hasOlder":false}`,
		topology: `{"taskId":"tA","nodes":[{"id":"n2","kind":"task","status":"running","label":"planner"}],"edges":[]}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	deadline := 3
	for index := 0; index < deadline; index++ {
		tester = frames(tester)
	}
	if !tester.HasText("图节点 planner") {
		t.Fatalf("the network panel renders the graph of the open graph agent, texts %q", tester.Texts())
	}
	if !tester.HasText("Graph · 1 节点 · 拖拽平移 · 滚轮缩放") {
		t.Fatalf("the network panel captions the graph, texts %q", tester.Texts())
	}
}

func TestTheDefaultWhiteboardShowsTheNetworkBesideTheAgentPanel(t *testing.T) {
	page := defaultBoardPages()[0]
	seen := map[string]bool{}
	for _, panel := range page.Panels {
		seen[panel.Kind] = true
	}
	if !seen["agent"] || !seen["agent-network"] {
		t.Fatalf("the whiteboard leads with the agent panel and its network, panels %+v", page.Panels)
	}
	if seen["artifacts"] {
		t.Fatalf("the generic artifacts card is gone from the whiteboard, panels %+v", page.Panels)
	}
}

func TestTheNetworkCanvasPansAndZooms(t *testing.T) {
	mock := &nodeChatMock{
		fleet: networkPanelFleet(),
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("g1")
	tester = frames(frames(tester))
	state.boardNet.view.fit = true
	state.boardNet.view.x = 0
	state.boardNet.view.y = 0
	canvas, ok := tester.Find("无限画布")
	if !ok {
		t.Fatalf("the network canvas never rendered, texts %q", tester.Texts())
	}
	tester.Wheel(canvas.X+canvas.W/2, canvas.Y+canvas.H/2, 0, -120)
	frames(tester)
	if state.boardNet.view.y == 0 {
		t.Fatal("the wheel must pan the network canvas")
	}
	before := state.boardNet.view.zoom
	if err := tester.Click("+"); err != nil {
		t.Fatalf("zoom in: %v", err)
	}
	frames(tester)
	if state.boardNet.view.zoom <= before {
		t.Fatalf("zoom in raises the zoom, %v -> %v", before, state.boardNet.view.zoom)
	}
	state.boardNet.view.x, state.boardNet.view.y = 999, 999
	if err := tester.Click("居中"); err != nil {
		t.Fatalf("center: %v", err)
	}
	frames(tester)
	if state.boardNet.view.x == 999 {
		t.Fatal("居中 re-centers the network")
	}
}

func TestTheNetworkCanvasDragsWithoutSwallowingClicks(t *testing.T) {
	mock := &nodeChatMock{
		fleet: networkPanelFleet(),
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("g1")
	tester = frames(frames(tester))
	state.boardNet.view.fit = true
	state.boardNet.view.zoom = 1
	state.boardNet.view.x = 20
	state.boardNet.view.y = 20
	frames(tester)
	canvas, ok := tester.Find("无限画布")
	if !ok {
		t.Fatalf("the network canvas never rendered, texts %q", tester.Texts())
	}
	x, y := canvas.X+canvas.W/2, canvas.Y+canvas.H/2
	tester.Press(x, y)
	tester.Move(x+60, y+40)
	frames(tester)
	tester.Release(x+60, y+40)
	frames(tester)
	if state.boardNet.view.x == 20 && state.boardNet.view.y == 20 {
		t.Fatal("dragging the empty canvas must pan it")
	}
}

func TestTheNetworkPanelFullScreenShowsTheSameNetwork(t *testing.T) {
	mock := &nodeChatMock{
		fleet: networkPanelFleet(),
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("g1")
	frames(tester)
	state.openModule("agent-network")
	tester = frames(frames(tester))
	if page := state.boardPage(); page == nil || page.Kind != "agent-network" {
		t.Fatalf("the full screen page is the network, page %+v", page)
	}
	if !tester.HasText("编队 · Main 中心 · Thread 环 · 拖拽平移 · 滚轮缩放") || !tester.HasText("居中") {
		t.Fatalf("the full screen keeps the same network canvas, texts %q", tester.Texts())
	}
}

func TestTheFleetAndWhiteboardNetworksAreOnePanel(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	openFleetTester(t, state).Frame()
	fleet := state.boardPage()
	var kind, scope string
	for _, panel := range fleet.Panels {
		if panel.ID == "fleet-network" {
			kind, scope = panel.Kind, panel.Scope
		}
	}
	if kind != "agent-network" || scope != "fleet" {
		t.Fatalf("the fleet page uses the shared agent network panel, panel kind %q scope %q", kind, scope)
	}
	for _, page := range state.board.pages {
		for _, panel := range page.Panels {
			if panel.Kind == "fleet-network" {
				t.Fatalf("no page keeps a second network panel, page %+v", page)
			}
		}
	}
}

func TestFullScreeningTheNetworkReusesOnePage(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	state.openModuleWithScope("agent-network", "fleet")
	tester = frames(tester)
	if page := state.boardPage(); page.Kind != "agent-network" || page.Scope != "fleet" {
		t.Fatalf("the fleet network opens its scoped page, page %+v", page)
	}
	first := len(state.board.pages)
	state.selectBoardPage(0)
	state.openModuleWithScope("agent-network", "")
	tester = frames(tester)
	if len(state.board.pages) != first {
		t.Fatalf("opening the network from the whiteboard reuses the page, pages %d want %d", len(state.board.pages), first)
	}
	if page := state.boardPage(); page.Scope != "" || page.Kind != "agent-network" {
		t.Fatalf("the reused page follows the entry point's scope, page %+v", page)
	}
	if !tester.HasText("居中") || !tester.HasText("无限画布") {
		t.Fatalf("both entry points show the same canvas, texts %q", tester.Texts())
	}
}

func TestLoadingAnOldBoardRenamesTheNetworkToTheSharedPanel(t *testing.T) {
	dir := t.TempDir()
	saved := `{"version":9,"active":1,"pages":[
		{"id":"board","title":"白板","panels":[{"id":"agent","kind":"agent"},{"id":"agent-network","kind":"agent-network"}],
		 "layout":{"kind":"split","axis":"row","children":[
			{"weight":1,"node":{"kind":"panel","panelId":"agent"}},
			{"weight":1,"node":{"kind":"panel","panelId":"agent-network"}}]}},
		{"id":"fleet","title":"编队","kind":"fleet","panels":[
			{"id":"fleet-kpi","kind":"fleet-kpi"},
			{"id":"fleet-network","kind":"fleet-network"}],
		 "layout":{"kind":"split","axis":"row","children":[
			{"weight":1,"node":{"kind":"panel","panelId":"fleet-kpi"}},
			{"weight":1,"node":{"kind":"panel","panelId":"fleet-network"}}]}},
		{"id":"tab-old","title":"Agent 网络","kind":"fleet-network","panels":[{"id":"fleet-network","kind":"fleet-network"}],
		 "layout":{"kind":"panel","panelId":"fleet-network"}},
		{"id":"tab-new","title":"Agent 网络","kind":"agent-network","panels":[{"id":"agent-network","kind":"agent-network"}],
		 "layout":{"kind":"panel","panelId":"agent-network"}}]}`
	if err := os.WriteFile(filepath.Join(dir, "whiteboard.json"), []byte(saved), 0o600); err != nil {
		t.Fatalf("write whiteboard: %v", err)
	}
	state := newShellState("http://127.0.0.1:1", "")
	state.loadBoard(dir)
	fleet := state.board.pages[1]
	if fleet.ID != "fleet" {
		t.Fatalf("the fleet page stays first after the board, pages %+v", state.board.pages)
	}
	networkPanel := boardPanel{}
	for _, panel := range fleet.Panels {
		if panel.ID == "fleet-network" {
			networkPanel = panel
		}
	}
	if networkPanel.Kind != "agent-network" || networkPanel.Scope != "fleet" {
		t.Fatalf("the fleet network becomes the shared scoped panel, panel %+v", networkPanel)
	}
	modulePages := 0
	for _, page := range state.board.pages {
		if page.Kind == "agent-network" {
			modulePages++
		}
	}
	if modulePages != 1 {
		t.Fatalf("the old network tabs collapse into one page, pages %+v", state.board.pages)
	}
}
