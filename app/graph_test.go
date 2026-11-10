package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

const graphConversation = `{"messages":[{"role":"assistant","text":"派了两个节点"}],"tasks":[
	{"id":"t1","request":"Harness probe","status":"completed","phase":"settle","nodes":[
		{"id":"current-model","role":"worker","kind":"agent","status":"succeeded","model":"opencode-go:deepseek","definitionVersion":"coder"},
		{"id":"gpt-5-5","role":"worker","kind":"agent","status":"failed","model":"gpt-5.5","definitionVersion":"coder"}
	]}]}`

const nodeRunFixture = `{"node":{"action":"读一下图片","model":"opencode-go:deepseek"},"entries":[
	{"kind":"message","role":"user","text":"GRAPH OVERVIEW: Harness probe\n第二行"},
	{"kind":"message","role":"assistant","text":"I'll read the image file now"},
	{"kind":"call","role":"assistant","text":"{\"path\":\"/tmp/vision-probe.png\"}","data":{"toolName":"read"}}
]}`

func graphServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c1":
			w.Write([]byte(graphConversation))
		case "/api/conversations/c1/artifacts":
			w.Write([]byte(`{"artifacts":[]}`))
		case "/api/tasks/t1/nodes/current-model/run":
			w.Write([]byte(nodeRunFixture))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestGraphTasksParseNodes(t *testing.T) {
	rows, err := parseGraphTasks([]byte(graphConversation))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].id != "t1" || len(rows[0].nodes) != 2 {
		t.Fatalf("rows %+v", rows)
	}
	if taskLabel(rows[0]) != "Harness probe · completed · settle" {
		t.Fatalf("task label %q", taskLabel(rows[0]))
	}
	if nodeLabel(rows[0].nodes[0]) != "current-model · worker · succeeded · opencode-go:deepseek" {
		t.Fatalf("node label %q", nodeLabel(rows[0].nodes[0]))
	}
	if nodeLabel(rows[0].nodes[1]) != "gpt-5-5 · worker · failed · gpt-5.5" {
		t.Fatalf("node label %q", nodeLabel(rows[0].nodes[1]))
	}
}

func TestNodeRunRendersEntries(t *testing.T) {
	run, err := parseNodeRun([]byte(nodeRunFixture))
	if err != nil {
		t.Fatal(err)
	}
	if run.action != "读一下图片" || len(run.entries) != 3 {
		t.Fatalf("run %+v", run)
	}
	if line := nodeEntryLine(run.entries[0]); line != "你 · GRAPH OVERVIEW: Harness probe" {
		t.Fatalf("the node transcript must show one line per entry, got %q", line)
	}
	if line := nodeEntryLine(run.entries[2]); line != `→ read · {"path":"/tmp/vision-probe.png"}` {
		t.Fatalf("a tool call must show its tool name, got %q", line)
	}
}

func TestGraphSectionOpensANode(t *testing.T) {
	server := graphServer(t)
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if len(state.tasks) != 1 {
		t.Fatalf("tasks %+v", state.tasks)
	}
	tester := ui.NewTester(state.view, 820, 700)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("图 · 1 个任务") {
		t.Fatalf("the graph toggle must show the task count, texts %q", tester.Texts())
	}
	if tester.HasText("current-model · worker · succeeded · opencode-go:deepseek") {
		t.Fatalf("the node list must stay collapsed, texts %q", tester.Texts())
	}
	if err := tester.Click("图 · 1 个任务"); err != nil {
		t.Fatalf("click the graph toggle: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("Harness probe · completed · settle") || !tester.HasText("gpt-5-5 · worker · failed · gpt-5.5") {
		t.Fatalf("the expanded graph must list the nodes, texts %q", tester.Texts())
	}
	if err := tester.Click("current-model · worker · succeeded · opencode-go:deepseek"); err != nil {
		t.Fatalf("click a node: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(state.nodeLines) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("节点记录 · current-model · worker · 3 条记录") {
		t.Fatalf("the node panel must name the node, texts %q", tester.Texts())
	}
	if !tester.HasText("你 · GRAPH OVERVIEW: Harness probe") || !tester.HasText(`→ read · {"path":"/tmp/vision-probe.png"}`) {
		t.Fatalf("the node panel must show the entries, texts %q", tester.Texts())
	}
}

func TestNodeChatSendsAndReloads(t *testing.T) {
	posted := ""
	sent := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/tasks/t1/nodes/current-model/messages":
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			sent = true
			w.Write([]byte(`{}`))
		case r.URL.Path == "/api/tasks/t1/nodes/current-model/run":
			if sent {
				w.Write([]byte(`{"entries":[{"kind":"message","role":"user","text":"再确认一次"},{"kind":"message","role":"assistant","text":"确认完了"}]}`))
				return
			}
			w.Write([]byte(nodeRunFixture))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.showNode("t1", nodeRow{id: "current-model", role: "worker"})
	if len(state.nodeLines) != 3 {
		t.Fatalf("node lines %+v", state.nodeLines)
	}
	tester := ui.NewTester(state.view, 820, 700)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("发给节点") {
		t.Fatalf("a selected node must offer a composer, texts %q", tester.Texts())
	}
	state.nodeDraft = "再确认一次"
	state.sendNodeMessage()
	if !contains(posted, "再确认一次") || !contains(posted, "requestId") {
		t.Fatalf("the node message body was %q", posted)
	}
	if len(state.nodeLines) != 2 || state.nodeLines[1] != "agent · 确认完了" {
		t.Fatalf("the node transcript must reload after sending, lines %+v", state.nodeLines)
	}
	if state.nodeDraft != "" {
		t.Fatalf("the draft must clear after sending, got %q", state.nodeDraft)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("agent · 确认完了") {
		t.Fatalf("the reloaded transcript must render, texts %q", tester.Texts())
	}
}
