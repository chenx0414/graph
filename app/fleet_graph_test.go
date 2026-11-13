package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

const fleetTopologySample = `{
  "taskId": "tA",
  "nodes": [
    {"id":"n0","kind":"action","action":"plan","status":"done","label":"Plan","boundDefinition":"plan","model":"deepseek-v4-flash"},
    {"id":"n1","kind":"action","action":"ship","status":"running","label":"Ship","boundDefinition":"ship","model":"deepseek-v4-flash"},
    {"id":"n2","kind":"action","action":"check","status":"idle","label":"Check","boundDefinition":"check","model":""}
  ],
  "edges": [{"id":"e1","from":"n0","to":"n1"},{"id":"e2","from":"n0","to":"n2"},{"id":"e3","from":"n1","to":"n2"}]
}`

func TestParseFleetTopologyAndLayers(t *testing.T) {
	data, err := parseFleetTopology([]byte(fleetTopologySample))
	if err != nil {
		t.Fatalf("parse topology: %v", err)
	}
	if len(data.Nodes) != 3 || len(data.Edges) != 3 || data.TaskID != "tA" {
		t.Fatalf("topology parses, %+v", data)
	}
	wantLevels := map[string]int{"n0": 0, "n1": 1, "n2": 2}
	for id, want := range wantLevels {
		if got := data.Levels[id]; got != want {
			t.Fatalf("node %s sits at level %d, want %d", id, got, want)
		}
	}
	for _, node := range data.Nodes {
		if node.W != 220 || node.H != 96 {
			t.Fatalf("node %s keeps a readable card, %.0fx%.0f", node.ID, node.W, node.H)
		}
	}
	if data.Nodes[0].X >= data.Nodes[1].X {
		t.Fatalf("layers run left to right, %.0f vs %.0f", data.Nodes[0].X, data.Nodes[1].X)
	}
	for _, edge := range data.Edges {
		if len(edge.Points) < 21 {
			t.Fatalf("edge %s is a sampled curve with %d points", edge.ID, len(edge.Points))
		}
		from, _ := fleetTopologyNodeByID(data.Nodes, edge.From)
		to, _ := fleetTopologyNodeByID(data.Nodes, edge.To)
		first, last := edge.Points[0], edge.Points[len(edge.Points)-1]
		if mathAbs(first[0]-(from.X+from.W)) > 0.5 || mathAbs(first[1]-(from.Y+from.H/2)) > 0.5 {
			t.Fatalf("edge %s starts at the parent right", edge.ID)
		}
		if mathAbs(last[0]-to.X) > 0.5 || mathAbs(last[1]-(to.Y+to.H/2)) > 0.5 {
			t.Fatalf("edge %s ends at the child left", edge.ID)
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
		_, _ = w.Write([]byte(m.topology))
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
	if !tester.HasText("打开线程详情") || !tester.HasText("3 节点 · 3 边") {
		t.Fatalf("the page shows its KPI, texts %q", tester.Texts())
	}
	for _, want := range []string{"图节点 Plan", "图节点 Ship"} {
		if !tester.HasText(want) {
			t.Fatalf("the page shows %q, texts %q", want, tester.Texts())
		}
	}
	if err := tester.Click("图节点 Ship"); err != nil {
		t.Fatalf("click the ship node: %v", err)
	}
	tester = frames(tester)
	page := state.boardPage()
	if page.ID != "agent:p1-n1" {
		t.Fatalf("a matched node opens its agent page, page %+v", page)
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
