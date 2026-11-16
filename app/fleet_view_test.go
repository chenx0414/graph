package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestTheFleetAPIparsesTheProjection(t *testing.T) {
	data, err := parseFleet([]byte(fleetSampleJSON))
	if err != nil {
		t.Fatalf("parse the fleet projection: %v", err)
	}
	if data.RootID != "g1" || data.Truncated {
		t.Fatalf("root %q truncated %v", data.RootID, data.Truncated)
	}
	if data.Stats != (fleetStats{Agents: 4, Running: 3, Tasks: 2, Messages: 42, Tokens: 120000, Cost: 1.25}) {
		t.Fatalf("stats %+v", data.Stats)
	}
	if len(data.Agents) != 4 || data.Agents[1].ID != "p1" || data.Agents[1].ParentID != "g1" || data.Agents[1].Kind != "project" {
		t.Fatalf("agents %+v", data.Agents)
	}
	if data.Agents[2].Model != "deepseek-v4-flash" || data.Agents[2].Tokens != 8000 || data.Agents[2].Status != "completed" {
		t.Fatalf("agent metrics %+v", data.Agents[2])
	}
	if len(data.Links) != 3 || data.Links[0] != (fleetLink{From: "g1", To: "p1", Kind: "parent"}) {
		t.Fatalf("links %+v", data.Links)
	}
	if len(data.Tasks) != 2 || data.Tasks[0].ID != "t1" || data.Tasks[0].OwnerAgentID != "p1" {
		t.Fatalf("tasks %+v", data.Tasks)
	}
	if len(data.Events) != 3 || data.Events[0].Type != "link.delegation" || data.Events[0].TargetAgentID != "p1" {
		t.Fatalf("events %+v", data.Events)
	}
	if len(data.Artifacts) != 1 || data.Artifacts[0].ProducerAgentID != "p1" || data.Artifacts[0].Size != 2048 || data.Artifacts[0].Version != 2 {
		t.Fatalf("artifacts %+v", data.Artifacts)
	}
}

func TestTheFleetAPIRejectsBrokenJSONAndAcceptsEmptyArrays(t *testing.T) {
	if _, err := parseFleet([]byte(`{"agents":`)); err == nil {
		t.Fatal("broken JSON must not parse")
	}
	empty := `{"rootId":"","truncated":true,"stats":{"agents":0,"running":0,"tasks":0,"messages":0,"tokens":0,"cost":0},"agents":[],"links":[],"tasks":[],"events":[],"artifacts":[]}`
	data, err := parseFleet([]byte(empty))
	if err != nil {
		t.Fatalf("an empty projection must parse: %v", err)
	}
	if data.Agents == nil || data.Links == nil || data.Tasks == nil || data.Events == nil || data.Artifacts == nil {
		t.Fatalf("empty arrays must stay non-nil, %+v", data)
	}
}

func TestTheFleetPageRendersTheProjection(t *testing.T) {
	var asked string
	state := fleetServerShell(t, func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Query().Get("conversationId")
		fleetSampleServer(w, r)
	})
	tester := openFleetTester(t, state)
	if asked != "g1" {
		t.Fatalf("the fleet request scopes by the active conversation, asked %q", asked)
	}
	for _, label := range []string{
		"编队总览窗口", "Agent 网络窗口", "跨 Agent 协作窗口", "协作任务窗口", "事件检查窗口", "共享产物窗口",
	} {
		if !tester.HasText(label) {
			t.Fatalf("the fleet page misses %q, texts %q", label, tester.Texts())
		}
	}
	for _, want := range []string{
		"Agent 数", "运行中", "工作项", "消息数", "Tokens", "成本",
		"主控", "13-Graph", "planner", "worker",
		"委派 实现四栏页面", "实现四栏页面", "补充编队测试", "docs/spec.md",
	} {
		if !tester.HasText(want) {
			t.Fatalf("the fleet page misses %q, texts %q", want, tester.Texts())
		}
	}
	if !tester.HasText("4 个 Agent") {
		t.Fatalf("the fleet page captions the tree, texts %q", tester.Texts())
	}
}

func TestTheFleetPageSaysItIsLoadingAndThenLands(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	state := fleetServerShell(t, func(w http.ResponseWriter, r *http.Request) {
		<-release
		fleetSampleServer(w, r)
	})
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	state.openModule("fleet")
	tester := frames(ui.NewTesterWith(state.view, 1440, 900, ui.TesterOptions{Preferences: ui.Preferences{ReduceMotion: true}}))
	if _, ok := tester.Find("加载占位"); !ok {
		t.Fatalf("the fleet page must show skeleton placeholders while loading, texts %q", tester.Texts())
	}
	once.Do(func() { close(release) })
	deadline := time.Now().Add(2 * time.Second)
	for state.fleet.data == nil {
		if !time.Now().Before(deadline) {
			t.Fatalf("the fleet data never landed, texts %q", tester.Texts())
		}
		tester.Frame()
	}
	tester = frames(tester)
	if !tester.HasText("主控") {
		t.Fatalf("the fleet page must swap the skeleton for the tree, texts %q", tester.Texts())
	}
	if _, ok := tester.Find("加载占位"); ok {
		t.Fatalf("the fleet page keeps no skeleton once the data lands, texts %q", tester.Texts())
	}
}

func TestTheFleetPageExplainsAFailedRead(t *testing.T) {
	state := fleetServerShell(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	state.openModule("fleet")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for state.fleet.failed == "" {
		if !time.Now().Before(deadline) {
			t.Fatalf("the fleet failure never landed, texts %q", tester.Texts())
		}
		tester.Frame()
	}
	tester = frames(tester)
	if !tester.HasText("读不到编队数据") {
		t.Fatalf("the fleet page must say why it is empty, texts %q", tester.Texts())
	}
}

func TestTheFleetPageExplainsAnEmptyFleet(t *testing.T) {
	state := fleetServerShell(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"rootId":"g1","truncated":false,"stats":{"agents":0,"running":0,"tasks":0,"messages":0,"tokens":0,"cost":0},"agents":[],"links":[],"tasks":[],"events":[],"artifacts":[]}`))
	})
	tester := openFleetTester(t, state)
	if !tester.HasText("编队还没有可展示的 Agent。") {
		t.Fatalf("the fleet page must explain an empty tree, texts %q", tester.Texts())
	}
}

func thousandAgentFleet() *fleetSnapshot {
	data := &fleetSnapshot{RootID: "g1", Stats: fleetStats{Agents: 1000, Running: 250, Tasks: 12, Messages: 900}}
	data.Agents = append(data.Agents, fleetAgent{ID: "g1", Kind: "global", Name: "主控", Status: "running", ConversationID: "g1"})
	for project := 0; project < 27; project++ {
		projectID := fmt.Sprintf("p%02d", project)
		title := fmt.Sprintf("项目 %d", project)
		data.Agents = append(data.Agents, fleetAgent{ID: projectID, ParentID: "g1", Kind: "project", Name: title, ProjectID: title, ConversationID: projectID, Status: "running"})
		for node := 0; node < 36; node++ {
			data.Agents = append(data.Agents, fleetAgent{
				ID:       fmt.Sprintf("%s-n%02d", projectID, node),
				ParentID: projectID,
				Kind:     "node",
				Name:     fmt.Sprintf("node-P%02d-%02d", project, node),
				Model:    "deepseek-v4-flash",
				Status:   "running",
				TaskID:   fmt.Sprintf("t%02d", project),
				NodeID:   fmt.Sprintf("n%02d", node),
			})
		}
	}
	return data
}

func TestTheFleetNetworkAggregatesAThousandAgents(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	state.fleet = fleetState{conversationID: "g1", data: thousandAgentFleet()}
	state.openModule("fleet")
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if !tester.HasText("1,000 个 Agent") {
		t.Fatalf("the network must caption the thousand agents, texts %q", tester.Texts())
	}
	units, threads := 0, 0
	for _, text := range tester.Texts() {
		if strings.HasPrefix(text, "编队图 ") {
			units++
		}
		if strings.HasPrefix(text, "编队 Agent 项目 ") {
			threads++
		}
	}
	if units != 13 || threads != 12 {
		t.Fatalf("a thousand agents show twelve graph units plus one aggregate: units %d threads %d", units, threads)
	}
	if !tester.HasText("其他 15 个图") {
		t.Fatalf("the aggregate graph chip names the hidden graphs, texts %q", tester.Texts())
	}
	if tester.HasText("node-P00-00") {
		t.Fatalf("graph agents must not render one by one, texts %q", tester.Texts())
	}
}

func TestTheFleetPageUsesTheFreeformBoardLayout(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	page := state.boardPage()
	want := []string{"fleet-kpi", "fleet-network", "fleet-collaboration", "fleet-tasks", "fleet-events", "fleet-artifacts"}
	if leaves := boardLeafIDs(&page.Layout); !sameStrings(leaves, want) {
		t.Fatalf("the fleet page is a freeform board over its layout, leaves %v", leaves)
	}
	if len(state.board.rects) < len(want) {
		t.Fatalf("the freeform pictures every panel for dragging, rects %+v", state.board.rects)
	}
	network, ok := state.board.rects["fleet-network"]
	if !ok {
		t.Fatalf("the network panel never laid out, rects %+v", state.board.rects)
	}
	tasks, ok := state.board.rects["fleet-tasks"]
	if !ok {
		t.Fatalf("the tasks panel never laid out, rects %+v", state.board.rects)
	}
	startX, startY := network.X+network.W/2, network.Y+12
	endX, endY := tasks.X+tasks.W/2, tasks.Y+tasks.H*0.6
	tester.Press(startX, startY)
	for step := 1; step <= 12; step++ {
		tester.Move(startX+(endX-startX)*float32(step)/12, startY+(endY-startY)*float32(step)/12)
		tester.Frame()
	}
	tester.Release(endX, endY)
	frames(tester)
	if leaves := boardLeafIDs(&state.boardPage().Layout); !sameStrings(leaves, []string{"fleet-kpi", "fleet-tasks", "fleet-collaboration", "fleet-network", "fleet-events", "fleet-artifacts"}) {
		t.Fatalf("dragging one fleet panel onto another swaps them, leaves %v", leaves)
	}
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

func TestClickingAGraphUnitOpensItsGraphPage(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	state.openModule("fleet")
	state.openModuleWithScope("agent-network", "fleet")
	tester := frames(ui.NewTester(state.view, 1880, 900))
	if err := tester.Click("编队图 实现四栏页面"); err != nil {
		t.Fatalf("click the graph unit: %v", err)
	}
	tester = frames(tester)
	page := state.boardPage()
	if page.ID != "graph:t1" || page.Kind != "fleet-graph" || page.Title != "实现四栏页面" {
		t.Fatalf("a graph unit opens its graph page, page %+v", page)
	}
	if !tester.HasText("标签页 实现四栏页面") {
		t.Fatalf("the graph page shows a tab, texts %q", tester.Texts())
	}
	if err := state.openFleetGraphPage(fleetGraphUnit{TaskID: "t1", Title: "实现四栏页面"}); err != nil {
		t.Fatalf("reopen the graph page: %v", err)
	}
	if count := len(state.board.pages); count != 4 {
		t.Fatalf("the graph page reuses its tab, pages %d", count)
	}
}

func TestTheAgentPageClosesLikeAModulePage(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	data := &fleetSnapshot{RootID: "g1", Stats: fleetStats{Agents: 2}, Agents: []fleetAgent{
		{ID: "g1", Kind: "global", Name: "Main", Status: "running"},
		{ID: "p1", ParentID: "g1", Kind: "project", Name: "13-Graph", ConversationID: "p1", Status: "running"},
	}}
	state.fleet = fleetState{conversationID: "g1", data: data}
	if err := state.openFleetAgentPage(data.Agents[1]); err != nil {
		t.Fatalf("open the agent page: %v", err)
	}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.Click("关闭 13-Graph"); err != nil {
		t.Fatalf("close the agent page: %v", err)
	}
	frames(tester)
	for _, page := range state.board.pages {
		if page.ID == "agent:p1" {
			t.Fatalf("the agent page stayed open, pages %+v", state.board.pages)
		}
	}
}

func TestTheFleetCardsCarryTheAgentMetrics(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	for _, want := range []string{"4 个 Agent · 3 运行中", "24.0k tokens", "$0.420", "3 步", "占比"} {
		if !tester.HasText(want) {
			t.Fatalf("the ring misses %q, texts %q", want, tester.Texts())
		}
	}
	for _, want := range []string{"编队图 实现四栏页面"} {
		if !tester.HasText(want) {
			t.Fatalf("the graph ring misses %q, texts %q", want, tester.Texts())
		}
	}
	accents := fleetAccents()
	seen := false
	for _, accent := range accents {
		if countColor(tester.Image(), accent) > 0 {
			seen = true
			break
		}
	}
	if !seen {
		t.Fatal("the agent cards paint a family accent")
	}
}

func TestClickingAFleetArtifactOpensTheSharedArtifactsPanel(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	if err := tester.Click("共享产物 docs/spec.md · v2 · 2.0 KB"); err != nil {
		t.Fatalf("click the artifact row: %v", err)
	}
	frames(tester)
	if state.activeBoardKind() != "artifacts" {
		t.Fatalf("an artifact row jumps to the shared artifacts panel, kind %q", state.activeBoardKind())
	}
}

func TestTheFleetCollaborationFiltersByAgent(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	if !tester.HasText("委派 · 主控 → 13-Graph") {
		t.Fatalf("the collaboration timeline shows the delegation, texts %q", tester.Texts())
	}
	if err := tester.Click("只看 planner"); err != nil {
		t.Fatalf("filter the timeline by agent: %v", err)
	}
	tester = frames(tester)
	if state.fleet.agentFilter != "n1" {
		t.Fatalf("the timeline filter keeps the agent, filter %q", state.fleet.agentFilter)
	}
	if tester.HasText("委派 · 主控 → 13-Graph") {
		t.Fatalf("the filtered timeline still shows other agents, texts %q", tester.Texts())
	}
	if !tester.HasText("投递 · planner → worker") {
		t.Fatalf("the filtered timeline must keep the planner rows, texts %q", tester.Texts())
	}
}

func TestTheFleetEventsFilterByCategory(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	if !tester.HasText("about.result") || !tester.HasText("link.delegation") {
		t.Fatalf("the event check lists the recent events, texts %q", tester.Texts())
	}
	if err := tester.Click("筛选 委派"); err != nil {
		t.Fatalf("filter the events: %v", err)
	}
	tester = frames(tester)
	if state.fleet.category != "delegate" {
		t.Fatalf("the event filter keeps the category, category %q", state.fleet.category)
	}
	if tester.HasText("about.result") {
		t.Fatalf("the filtered event check still shows a result event, texts %q", tester.Texts())
	}
	if !tester.HasText("link.delegation") {
		t.Fatalf("the filtered event check must keep the delegation event, texts %q", tester.Texts())
	}
}

func TestFleetStatusLabelsCoverTheContractStatuses(t *testing.T) {
	for status, want := range map[string]string{
		"running":   "运行中",
		"idle":      "空闲",
		"done":      "完成",
		"completed": "完成",
		"blocked":   "阻塞",
		"failed":    "失败",
		"stopped":   "已停止",
		"":          "未知",
		"custom":    "custom",
	} {
		if got := fleetStatusLabel(status); got != want {
			t.Fatalf("status %q reads %q, want %q", status, got, want)
		}
	}
}

func TestFleetEventCategoriesCoverTheLedgerEvents(t *testing.T) {
	for eventType, want := range map[string]string{
		"work.delegated":       "delegate",
		"link.delegation":      "delegate",
		"work.spawned":         "spawn",
		"link.delivery":        "deliver",
		"about.result":         "deliver",
		"work.completed":       "result",
		"work.question":        "question",
		"conversation.created": "other",
		"graph.node.started":   "other",
		"work.graph.confirmed": "other",
		"graph.node.completed": "result",
		"work.request.failed":  "other",
	} {
		if got := fleetEventCategory(fleetEvent{Type: eventType}); got != want {
			t.Fatalf("event %q maps to %q, want %q", eventType, got, want)
		}
	}
}

func TestTheFleetNetworkStartsAtTheWorldOrigin(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	state.openModule("fleet")
	state.openModuleWithScope("agent-network", "fleet")
	frames(ui.NewTester(state.view, 1440, 900))
	if state.boardNet.view.x != 0 && state.boardNet.view.zoom == 0 {
		t.Fatalf("the network canvas starts fitted, view %+v", state.boardNet.view)
	}
}

func TestTheFleetTabResetsFromItsContextMenu(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	state.openModule("fleet")
	state.board.pages[1].Panels = state.board.pages[1].Panels[:2]
	state.board.pages[1].Layout = layoutFromPanels(state.board.pages[1].Panels)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.RightClick("标签页 编队"); err != nil {
		t.Fatalf("open the fleet tab menu: %v", err)
	}
	menu := tester.Menu()
	found := false
	for _, item := range menu {
		if item == "重置编队为默认初始状态" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the fleet tab menu misses reset, menu %q", menu)
	}
	if err := tester.ChooseMenuItem("重置编队为默认初始状态"); err != nil {
		t.Fatalf("choose reset: %v", err)
	}
	frames(tester)
	if len(state.board.pages[1].Panels) != len(defaultFleetPanels()) {
		t.Fatalf("the fleet kept its panels, %+v", state.board.pages[1].Panels)
	}
	if state.board.active != 1 || state.board.pages[1].ID != fleetPageID {
		t.Fatalf("reset leaves the fleet tab active, pages %+v active %d", state.board.pages, state.board.active)
	}
}
