package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

const fleetTopologySample = `{
  "taskId": "tA",
  "nodes": [
    {"id":"n0","kind":"action","action":"探索当前项目","status":"running","label":"Research","boundDefinition":"research","model":"deepseek-v4-flash"},
    {"id":"n1","kind":"action","action":"实现编队图后端","status":"done","label":"fleet-backend","boundDefinition":"backend","model":"deepseek-v4-flash"},
    {"id":"n2","kind":"action","action":"重做 Graph 页视觉","status":"running","label":"fleet-ui","boundDefinition":"ui","model":"deepseek-v4-flash"},
    {"id":"n3","kind":"module","action":"核对规模与占比","status":"idle","label":"scale-engineer","boundDefinition":"scale","model":""},
    {"id":"n4","kind":"action","action":"回收结果并归档","status":"idle","label":"archive","boundDefinition":"archive","model":"deepseek-v4-flash"}
  ],
  "edges": [{"id":"e1","from":"n0","to":"n1"},{"id":"e2","from":"n0","to":"n2"},{"id":"e3","from":"n1","to":"n3"},{"id":"e4","from":"n2","to":"n4"}]
}`

func TestParseFleetTopologyAndLayers(t *testing.T) {
	data, err := parseFleetTopology([]byte(fleetTopologySample))
	if err != nil {
		t.Fatalf("parse topology: %v", err)
	}
	if len(data.Nodes) != 5 || len(data.Edges) != 4 || data.TaskID != "tA" {
		t.Fatalf("topology parses, %+v", data)
	}
	wantLevels := map[string]int{"n0": 0, "n1": 1, "n2": 1, "n3": 2, "n4": 2}
	for id, want := range wantLevels {
		if got := data.Levels[id]; got != want {
			t.Fatalf("node %s sits at level %d, want %d", id, got, want)
		}
	}
	for _, node := range data.Nodes {
		if node.W != 260 || node.H != 116 {
			t.Fatalf("node %s keeps its DSH card, %.0fx%.0f", node.ID, node.W, node.H)
		}
	}
	root, _ := fleetTopologyNodeByID(data.Nodes, "n0")
	first, _ := fleetTopologyNodeByID(data.Nodes, "n1")
	second, _ := fleetTopologyNodeByID(data.Nodes, "n2")
	grand, _ := fleetTopologyNodeByID(data.Nodes, "n3")
	if root.Y >= first.Y || first.Y >= grand.Y {
		t.Fatalf("layers run top to bottom, %.0f %.0f %.0f", root.Y, first.Y, grand.Y)
	}
	if first.Y != second.Y {
		t.Fatalf("siblings share a layer, %.0f vs %.0f", first.Y, second.Y)
	}
	middle := (first.X + second.X + second.W) / 2
	if delta := middle - (root.X + root.W/2); delta < -1 || delta > 1 {
		t.Fatalf("the root centers over its children, delta %.1f", delta)
	}
	for _, edge := range data.Edges {
		if len(edge.Points) < 21 {
			t.Fatalf("edge %s is a sampled curve with %d points", edge.ID, len(edge.Points))
		}
		from, _ := fleetTopologyNodeByID(data.Nodes, edge.From)
		to, _ := fleetTopologyNodeByID(data.Nodes, edge.To)
		first, last := edge.Points[0], edge.Points[len(edge.Points)-1]
		if mathAbs(first[0]-(from.X+from.W/2)) > 0.5 || mathAbs(first[1]-(from.Y+from.H)) > 0.5 {
			t.Fatalf("edge %s starts at the parent bottom", edge.ID)
		}
		if mathAbs(last[0]-(to.X+to.W/2)) > 0.5 || mathAbs(last[1]-to.Y) > 0.5 {
			t.Fatalf("edge %s ends at the child top", edge.ID)
		}
	}
}

func mathAbs(value float32) float32 {
	if value < 0 {
		return -value
	}
	return value
}

func TestFleetTopologyWithoutEdgesUsesAGrid(t *testing.T) {
	data, err := parseFleetTopology([]byte(`{"taskId":"t1","nodes":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"},{"id":"e"}],"edges":[]}`))
	if err != nil {
		t.Fatalf("parse grid topology: %v", err)
	}
	if data.Levels["e"] == 0 {
		t.Fatalf("the fifth node wraps to the next grid row, %+v", data.Levels)
	}
}

type fleetGraphMock struct {
	mu       sync.Mutex
	topology string
	status   int
	fleet    *fleetSnapshot
}

func (m *fleetGraphMock) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/fleet", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(m.fleet)
	})
	mux.HandleFunc("/api/tasks/", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if m.status != 0 {
			w.WriteHeader(m.status)
			return
		}
		if strings.Contains(r.URL.Path, "/graph/topology") {
			_, _ = w.Write([]byte(m.topology))
			return
		}
		_, _ = w.Write([]byte(`{"entries":[{"seq":1,"id":"e1","role":"system","kind":"note","text":"节点已启动","createdAt":1},{"seq":2,"id":"e2","role":"assistant","kind":"message","text":"正在实现编队图","createdAt":2}]}`))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func fleetGraphTester(t *testing.T, mock *fleetGraphMock, data *fleetSnapshot) (*shellState, *ui.Tester) {
	t.Helper()
	server := mock.server(t)
	state := fleetServerShell(t, fleetSampleServer)
	state.api = newAPIClient(server.URL, "")
	state.fleet = fleetState{conversationID: "g1", data: data}
	state.board.pages = append(state.board.pages, boardPage{
		ID: "graph:tA", Title: "Ship it", Kind: "fleet-graph",
		Panels: []boardPanel{{ID: "graph-dag", Kind: "graph-dag"}},
		Layout: boardNode{Kind: "panel", PanelID: "graph-dag"},
	})
	state.board.active = len(state.board.pages) - 1
	tester := ui.NewTester(state.view, 1440, 900)
	for index := 0; index < 30; index++ {
		tester.Frame()
		if state.graph.data != nil || state.graph.failed != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return state, tester
}

func TestGraphPageRendersNodesAndOpensTheAgent(t *testing.T) {
	mock := &fleetGraphMock{topology: fleetTopologySample, fleet: ringGraphFleet()}
	state, tester := fleetGraphTester(t, mock, ringGraphFleet())
	if state.graph.data == nil {
		t.Fatalf("the graph page loads its topology: %+v", state.graph)
	}
	frames(tester)
	if !tester.HasText("Graph 编队") {
		t.Fatalf("the panel is titled Graph 编队, texts %q", tester.Texts())
	}
	if !tester.HasText("打开线程详情") || !tester.HasText("5 节点 · 4 边") {
		t.Fatalf("the page shows its KPI, texts %q", tester.Texts())
	}
	for _, want := range []string{"图节点 Research", "图节点 fleet-ui", "100 tokens", "0 步", "占比 25.0%"} {
		if !tester.HasText(want) {
			t.Fatalf("the page shows %q, texts %q", want, tester.Texts())
		}
	}
	for _, want := range []string{"图节点 Research", "图节点 fleet-ui"} {
		if !tester.HasText(want) {
			t.Fatalf("the page shows %q, texts %q", want, tester.Texts())
		}
	}
	if err := tester.Click("图节点 fleet-ui"); err != nil {
		t.Fatalf("click the ship node: %v", err)
	}
	tester = frames(tester)
	active := state.active()
	if active == nil || active.active != "node:tA/n2" {
		t.Fatalf("a matched node opens its node chat, active %+v", active)
	}
	if !tester.HasText("正在实现编队图") || !tester.HasText("节点已启动") {
		t.Fatalf("the node chat renders its entries, texts %q", tester.Texts())
	}
}

func TestGraphPageHoverUsesTheSharedStyle(t *testing.T) {
	mock := &fleetGraphMock{topology: fleetTopologySample, fleet: ringGraphFleet()}
	state, tester := fleetGraphTester(t, mock, ringGraphFleet())
	frames(tester)
	rect, ok := tester.Find("图节点 fleet-ui")
	if !ok {
		t.Fatalf("the fleet-ui card lays out, texts %q", tester.Texts())
	}
	tester.Move(rect.X+rect.W/2, rect.Y+rect.H/2)
	frames(tester)
	if state.fleet.hoverID != "n2" {
		t.Fatalf("hovering a graph card reuses the shared hover, got %q", state.fleet.hoverID)
	}
}

func TestGraphPageShowsFailureAndRetries(t *testing.T) {
	mock := &fleetGraphMock{topology: "", status: http.StatusInternalServerError, fleet: ringGraphFleet()}
	state, tester := fleetGraphTester(t, mock, ringGraphFleet())
	frames(tester)
	if state.graph.failed == "" {
		t.Fatalf("a failed topology is not silent, %+v", state.graph)
	}
	if !tester.HasText("重试") {
		t.Fatalf("the page offers a retry, texts %q", tester.Texts())
	}
	mock.mu.Lock()
	mock.status = 0
	mock.topology = fleetTopologySample
	mock.mu.Unlock()
	_ = state
}

func TestGraphPageEmptyTopology(t *testing.T) {
	mock := &fleetGraphMock{topology: `{"taskId":"tA","nodes":[],"edges":[]}`, fleet: ringGraphFleet()}
	_, tester := fleetGraphTester(t, mock, ringGraphFleet())
	frames(tester)
	if !tester.HasText("这张图还没有节点") {
		t.Fatalf("the empty graph explains itself, texts %q", tester.Texts())
	}
}

func TestFleetTopologyLayoutTerminatesOnCycles(t *testing.T) {
	data := &fleetTopologyData{Nodes: []fleetTopologyNode{{ID: "a"}, {ID: "b"}, {ID: "c"}}, Levels: map[string]int{}}
	data.Edges = []fleetTopologyEdge{{ID: "ab", From: "a", To: "b"}, {ID: "bc", From: "b", To: "c"}, {ID: "ca", From: "c", To: "a"}}
	fleetTopologyLayout(data)
	if data.Width <= 0 || data.Height <= 0 || len(data.Edges) != 3 {
		t.Fatalf("cyclic topology layout = %+v", data)
	}
	if data.Nodes[0].Y == data.Nodes[1].Y && data.Nodes[1].Y == data.Nodes[2].Y {
		t.Fatalf("cycle nodes should still lay out: %+v", data.Nodes)
	}
}

func TestGraphPageInitializesTheFleetAccentsItPaintsWith(t *testing.T) {
	mock := &fleetGraphMock{topology: fleetTopologySample, fleet: ringGraphFleet()}
	state, tester := fleetGraphTester(t, mock, ringGraphFleet())
	state.fleet.accents = nil
	frames(tester)
	state.openModule("graph:tA")
	tester = frames(tester)
	if state.fleet.accents == nil {
		t.Fatal("opening the graph page must initialize the accents used by its cards and edges")
	}
}
