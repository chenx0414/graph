// graph:table-writes-exempt: a test seeds the rows it reopens around
package graph

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func topologyStringPtr(value string) *string {
	return &value
}

func topologyTestNode(id, kind, action, status, label, boundDefinition, model string) appGraphNode {
	return appGraphNode{
		ID: id, Kind: kind, Action: action, Status: status, Label: label,
		BoundDefinition: boundDefinition, Model: model,
	}
}

func topologyFixtureDefinition() GraphDefinition {
	return GraphDefinition{
		Nodes: map[string]NodeDefinition{
			"planner": {Recipe: "matt-team-planner@1", Task: "planner: build the ring", Model: topologyStringPtr("deepseek-v4.1-flash")},
			"worker":  {Recipe: "matt-team-worker@1", Task: "worker: build the ring"},
		},
		Modules: map[string]ModuleDefinition{
			"decision": {Type: "router", Trigger: "each"},
		},
		Edges: map[string]EdgeDefinition{
			"planned":  {From: "planner.result", To: "worker.job", Enabled: true},
			"rework":   {From: "decision.rework", To: "worker.job", Enabled: true},
			"disabled": {From: "planner.result", To: "worker.job", Enabled: false},
			"unknown":  {From: "ghost.result", To: "worker.job", Enabled: true},
		},
	}
}

func topologyFixtureNodes() []appGraphNode {
	return []appGraphNode{
		topologyTestNode("planner", "agent", "planner: build the ring", "idle", "planner", "matt-team-planner@1", "deepseek-v4.1-flash"),
		topologyTestNode("worker", "agent", "worker: build the ring", "running", "worker", "matt-team-worker@1", ""),
		topologyTestNode("decision", "module", "route", "succeeded", "decision", "", ""),
	}
}

func TestGraphTopologyViewStripsPortsAndKeepsEdgeKeys(t *testing.T) {
	view := graphTopologyView("task-1", topologyFixtureDefinition(), topologyFixtureNodes())
	if view.TaskId != "task-1" {
		t.Fatalf("taskId is %q", view.TaskId)
	}
	wantNodes := topologyFixtureNodes()
	if len(view.Nodes) != len(wantNodes) {
		t.Fatalf("nodes are %+v", view.Nodes)
	}
	for index, node := range view.Nodes {
		want := wantNodes[index]
		if node.ID != want.ID || node.Kind != want.Kind || node.Action != want.Action ||
			node.Status != want.Status || node.Label != want.Label ||
			node.BoundDefinition != want.BoundDefinition || node.Model != want.Model {
			t.Fatalf("node %d is %+v, want %+v", index, node, want)
		}
	}
	edges := map[string]appGraphTopologyEdge{}
	for _, edge := range view.Edges {
		edges[edge.ID] = edge
	}
	if len(edges) != 2 {
		t.Fatalf("edges are %+v", view.Edges)
	}
	if edges["planned"].From != "planner" || edges["planned"].To != "worker" {
		t.Fatalf("a port endpoint must be stripped to its node: %+v", edges["planned"])
	}
	if edges["rework"].From != "decision" || edges["rework"].To != "worker" {
		t.Fatalf("a module endpoint must be stripped to its node: %+v", edges["rework"])
	}
	if _, ok := edges["disabled"]; ok {
		t.Fatalf("a disabled edge must be skipped: %+v", edges["disabled"])
	}
	if _, ok := edges["unknown"]; ok {
		t.Fatalf("an edge to an unknown node must be skipped: %+v", edges["unknown"])
	}
}

func TestGraphTopologyViewKeepsModuleNodes(t *testing.T) {
	view := graphTopologyView("task-1", topologyFixtureDefinition(), topologyFixtureNodes())
	modules := []appGraphTopologyNode{}
	for _, node := range view.Nodes {
		if node.Kind == "module" {
			modules = append(modules, node)
		}
	}
	if len(modules) != 1 || modules[0].ID != "decision" || modules[0].Action != "route" {
		t.Fatalf("module nodes are %+v", modules)
	}
}

func TestGraphTopologyViewIsEmptyWithoutAGraph(t *testing.T) {
	view := graphTopologyView("task-empty", GraphDefinition{}, nil)
	if view.TaskId != "task-empty" || len(view.Nodes) != 0 || len(view.Edges) != 0 {
		t.Fatalf("empty view is %+v", view)
	}
	if view.Nodes == nil || view.Edges == nil {
		t.Fatalf("empty arrays must not be nil: %+v", view)
	}
	body, err := json.Marshal(view)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(body) != `{"taskId":"task-empty","nodes":[],"edges":[]}` {
		t.Fatalf("empty payload is %s", body)
	}
}

func TestGraphTopologyViewSkipsEdgesWithoutEndpoints(t *testing.T) {
	definition := GraphDefinition{Edges: map[string]EdgeDefinition{
		"planned": {From: "planner.result", To: "worker.job", Enabled: true},
	}}
	view := graphTopologyView("task-1", definition, nil)
	if len(view.Edges) != 0 {
		t.Fatalf("no nodes means no edges, got %+v", view.Edges)
	}
}

func seedTopologyApp(t *testing.T) (*GraphApp, *KernelStore) {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "topology.sqlite"))
	t.Cleanup(store.Close)
	kernel := NewKernelStore(store)
	for _, query := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`,
		`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('2484591f-topology','p1','ring topology',1)`,
		`INSERT INTO tasks(id,project_id,request,created_seq) VALUES('2484591f-empty','p1','no graph yet',2)`,
	} {
		if _, err := store.DB.Exec(query); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	kernel.InsertRevision("2484591f-topology", topologyFixtureDefinition(), "topology fixture")
	return CreateApp(&TaskRuntime{store: store, kernel: kernel}, AppOptions{}), kernel
}

func topologyRequest(t *testing.T, app *GraphApp, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
	recorder := httptest.NewRecorder()
	app.ServeHTTP(recorder, request)
	return recorder
}

func TestGraphTopologyHandlerReturnsTheDefinitionWithoutLayout(t *testing.T) {
	app, _ := seedTopologyApp(t)
	recorder := topologyRequest(t, app, "/api/tasks/2484591f-topology/graph/topology")
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET topology -> %d %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if strings.Contains(body, `"layout"`) || strings.Contains(body, `"positions"`) {
		t.Fatalf("the topology endpoint must not carry a layout: %s", body)
	}
	var view appGraphTopology
	if err := json.Unmarshal([]byte(body), &view); err != nil {
		t.Fatalf("decode topology: %v", err)
	}
	if view.TaskId != "2484591f-topology" {
		t.Fatalf("taskId is %q", view.TaskId)
	}
	if len(view.Nodes) != 3 || len(view.Edges) != 2 {
		t.Fatalf("topology is %+v", view)
	}
	planner := view.Nodes[0]
	if planner.ID != "planner" || planner.Kind != "agent" || planner.Label != "planner agent" ||
		planner.BoundDefinition != "matt-team-planner@1" || planner.Model != "deepseek-v4.1-flash" {
		t.Fatalf("first node is %+v", planner)
	}
	edge := view.Edges[0]
	if edge.ID != "planned" || edge.From != "planner" || edge.To != "worker" {
		t.Fatalf("first edge is %+v", edge)
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatalf("decode raw: %v", err)
	}
	for _, key := range []string{"taskId", "nodes", "edges"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("the payload has no %q: %v", key, raw)
		}
	}
	node := raw["nodes"].([]any)[0].(map[string]any)
	for _, key := range []string{"id", "kind", "action", "status", "label", "boundDefinition", "model"} {
		if _, ok := node[key]; !ok {
			t.Fatalf("node has no %q: %v", key, node)
		}
	}
	rawEdge := raw["edges"].([]any)[0].(map[string]any)
	for _, key := range []string{"id", "from", "to"} {
		if _, ok := rawEdge[key]; !ok {
			t.Fatalf("edge has no %q: %v", key, rawEdge)
		}
	}
}

func TestGraphTopologyHandlerReturnsEmptyArraysWithoutAGraph(t *testing.T) {
	app, _ := seedTopologyApp(t)
	for _, taskId := range []string{"2484591f-empty", "no-such-task"} {
		recorder := topologyRequest(t, app, "/api/tasks/"+taskId+"/graph/topology")
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s -> %d %s", taskId, recorder.Code, recorder.Body.String())
		}
		body := recorder.Body.String()
		if !strings.Contains(body, `"nodes":[]`) || !strings.Contains(body, `"edges":[]`) {
			t.Fatalf("%s payload is %s", taskId, body)
		}
		var view appGraphTopology
		if err := json.Unmarshal([]byte(body), &view); err != nil {
			t.Fatalf("%s decode: %v", taskId, err)
		}
		if view.TaskId != taskId || len(view.Nodes) != 0 || len(view.Edges) != 0 {
			t.Fatalf("%s view is %+v", taskId, view)
		}
	}
}

func TestGraphTopologyNodesComeFromTheKernelGraphStatuses(t *testing.T) {
	app, kernel := seedTopologyApp(t)
	native := app.appKernelGraphTopology("2484591f-topology")
	if native == nil {
		t.Fatal("the seeded kernel graph was not found")
	}
	nodes := app.appNativeGraphNodes(native.Definition, native)
	if len(nodes) != 3 {
		t.Fatalf("nodes are %+v", nodes)
	}
	for _, node := range nodes {
		if node.Status != "idle" {
			t.Fatalf("without kernel node state the status must default to idle: %+v", node)
		}
	}
	if nodes[0].ID != "planner" || nodes[2].Kind != "module" {
		t.Fatalf("nodes order/kind is %+v", nodes)
	}
	kernel.InsertRevision("2484591f-topology", topologyFixtureDefinition(), "second revision")
	revisions := kernelRows(app.runtime.store.DB, "SELECT version FROM kernel_revisions WHERE task_id=? ORDER BY version", "2484591f-topology")
	if len(revisions) != 2 {
		t.Fatalf("fixture revisions are %+v", revisions)
	}
	if !reflect.DeepEqual(appSortedKeys(native.Definition.Nodes), []string{"planner", "worker"}) {
		t.Fatalf("definition nodes are %v", appSortedKeys(native.Definition.Nodes))
	}
}
