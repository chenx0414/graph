package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 20 tasks including terminal ones -- the old fleet panel would only show 12.
const fleetHistoryTasksSample = `[
  {"id":"t01","projectId":"p1","request":"历史图一","phase":"completed","status":"completed","conversationId":"c1","createdAt":1000,"updatedAt":1100,"openQuestions":0},
  {"id":"t02","projectId":"p1","request":"历史图二","phase":"stopped","status":"stopped","conversationId":"c1","createdAt":2000,"updatedAt":2100,"openQuestions":0},
  {"id":"t03","projectId":"p1","request":"阻塞任务","phase":"executing","status":"blocked","conversationId":"c1","createdAt":3000,"updatedAt":3100,"openQuestions":1},
  {"id":"t04","projectId":"p1","request":"讨论任务","phase":"discussing","status":"running","conversationId":"c1","createdAt":4000,"updatedAt":4100,"openQuestions":0},
  {"id":"t05","projectId":"p1","request":"运行中任务","phase":"executing","status":"running","conversationId":"c1","createdAt":5000,"updatedAt":5100,"openQuestions":0},
  {"id":"t06","projectId":"p1","request":"任务六","phase":"completed","status":"completed","conversationId":"c1","createdAt":6000,"updatedAt":6100,"openQuestions":0},
  {"id":"t07","projectId":"p1","request":"任务七","phase":"completed","status":"completed","conversationId":"c1","createdAt":7000,"updatedAt":7100,"openQuestions":0},
  {"id":"t08","projectId":"p1","request":"任务八","phase":"completed","status":"completed","conversationId":"c1","createdAt":8000,"updatedAt":8100,"openQuestions":0},
  {"id":"t09","projectId":"p1","request":"任务九","phase":"completed","status":"completed","conversationId":"c1","createdAt":9000,"updatedAt":9100,"openQuestions":0},
  {"id":"t10","projectId":"p1","request":"任务十","phase":"completed","status":"completed","conversationId":"c1","createdAt":10000,"updatedAt":10100,"openQuestions":0},
  {"id":"t11","projectId":"p1","request":"任务十一","phase":"completed","status":"completed","conversationId":"c1","createdAt":11000,"updatedAt":11100,"openQuestions":0},
  {"id":"t12","projectId":"p1","request":"任务十二","phase":"completed","status":"completed","conversationId":"c1","createdAt":12000,"updatedAt":12100,"openQuestions":0},
  {"id":"t13","projectId":"p1","request":"任务十三","phase":"completed","status":"completed","conversationId":"c1","createdAt":13000,"updatedAt":13100,"openQuestions":0},
  {"id":"t14","projectId":"p1","request":"任务十四","phase":"completed","status":"completed","conversationId":"c1","createdAt":14000,"updatedAt":14100,"openQuestions":0},
  {"id":"t15","projectId":"p1","request":"任务十五","phase":"completed","status":"completed","conversationId":"c1","createdAt":15000,"updatedAt":15100,"openQuestions":0},
  {"id":"t16","projectId":"p2","request":"别的项目任务","phase":"completed","status":"completed","conversationId":"c2","createdAt":16000,"updatedAt":16100,"openQuestions":0},
  {"id":"t17","projectId":"","request":"未归属任务","phase":"failed","status":"failed","conversationId":null,"createdAt":17000,"updatedAt":17100,"openQuestions":0}
]`

func TestParseHistoryGraphsKeepsTerminalTasks(t *testing.T) {
	tasks, err := parseHistoryGraphs([]byte(fleetHistoryTasksSample))
	if err != nil {
		t.Fatalf("parse history graphs: %v", err)
	}
	if len(tasks) != 17 {
		t.Fatalf("all tasks load without truncation, got %d want 17", len(tasks))
	}
	terminal := map[string]bool{}
	for _, task := range tasks {
		if workStatusOf(task.Status).Terminal() {
			terminal[task.ID] = true
		}
	}
	for _, id := range []string{"t01", "t02", "t06", "t16"} {
		if !terminal[id] {
			t.Fatalf("task %s keeps its terminal status, tasks %+v", id, tasks)
		}
	}
	if tasks[0].ProjectID != "p1" || tasks[0].Request != "历史图一" {
		t.Fatalf("task fields survive parsing, %+v", tasks[0])
	}
	if tasks[16].ConversationID != "" {
		t.Fatalf("null conversation id becomes empty, %+v", tasks[16])
	}
}

func TestHistoryGraphsByProjectAndSort(t *testing.T) {
	tasks, err := parseHistoryGraphs([]byte(fleetHistoryTasksSample))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	projects := historyGraphProjects(tasks)
	if len(projects) != 3 || projects[0] != "" || projects[1] != "p1" || projects[2] != "p2" {
		t.Fatalf("projects sorted with unassigned first, got %q", projects)
	}
	p1 := historyGraphsOfProject(tasks, "p1")
	if len(p1) != 15 {
		t.Fatalf("project p1 keeps all 15 tasks (no 12-item cut), got %d", len(p1))
	}
	// Newest first so the user sees the most relevant history immediately.
	if p1[0].ID != "t15" || p1[len(p1)-1].ID != "t01" {
		t.Fatalf("history sorted newest first, got %s..%s", p1[0].ID, p1[len(p1)-1].ID)
	}
}

func fleetHistoryServer(t *testing.T, tasks string) (*shellState, func()) {
	t.Helper()
	var mu sync.Mutex
	graphOpened := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/tasks":
			_, _ = w.Write([]byte(tasks))
		case r.URL.Path == "/api/conversations":
			_, _ = w.Write([]byte(`[{"id":"c1","title":"项目会话","role":"project","archivedAt":null}]`))
		case r.URL.Path == "/api/fleet":
			_, _ = w.Write([]byte(`{"rootId":"","truncated":false,"stats":{},"agents":[],"links":[],"tasks":[],"events":[],"artifacts":[]}`))
		case strings.HasPrefix(r.URL.Path, "/api/tasks/") && strings.HasSuffix(r.URL.Path, "/graph/topology"):
			mu.Lock()
			graphOpened = r.URL.Path
			mu.Unlock()
			_, _ = w.Write([]byte(`{"taskId":"t01","nodes":[{"id":"n1","kind":"action","action":"节点","status":"done"}],"edges":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	state := newShellState(server.URL, "tok")
	return state, func() {
		server.Close()
		_ = graphOpened
	}
}

func TestFleetHistoryPageListsAllTasksAndOpensGraph(t *testing.T) {
	state, cleanup := fleetHistoryServer(t, fleetHistoryTasksSample)
	defer cleanup()
	state.openFleetHistoryPage("p1")
	state.ensureFleetHistory()
	tester := frames(ui.NewTester(state.view, 1280, 800))
	all := strings.Join(tester.Texts(), "|")
	// No 12-row cut: the header reports all 15 tasks of the project, and a
	// terminal task (completed/stopped) is on screen like any other.
	if !strings.Contains(all, "共 15 个历史图") {
		t.Fatalf("history page reports the full count, texts %q", all)
	}
	if !strings.Contains(all, "历史图一") && !strings.Contains(all, "任务十五") {
		t.Fatalf("history page lists tasks, texts %q", all)
	}
	// The newest task sorts to the top and is always visible; clicking it
	// opens its graph page.
	if err := tester.Click("任务十五"); err != nil {
		t.Fatalf("click history task: %v, texts %q", err, tester.Texts())
	}
	tester = frames(tester)
	page := state.boardPage()
	if page == nil || page.Kind != "fleet-graph" {
		t.Fatalf("clicking history task opens its graph, page %+v", page)
	}
}

func TestFleetHistoryTaskOpensConversation(t *testing.T) {
	tasks, err := parseHistoryGraphs([]byte(fleetHistoryTasksSample))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	found := false
	for _, task := range tasks {
		if task.ID == "t01" && task.ConversationID == "c1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("history task keeps the link to its conversation, tasks %+v", tasks)
	}
}

func TestFleetHistoryPageIDRoundTrip(t *testing.T) {
	id := fleetHistoryPageID("p1")
	if fleetHistoryProjectOfPage(id) != "p1" {
		t.Fatalf("history page round-trips project id, %q", id)
	}
}

func TestFleetHistoryPayloadRoundTrip(t *testing.T) {
	tasks := []historyGraph{{ID: "t1", ProjectID: "p1", Request: "图", Status: "completed"}}
	payload, err := json.Marshal(tasks)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	parsed, err := parseHistoryGraphs(payload)
	if err != nil || len(parsed) != 1 || parsed[0].ID != "t1" {
		t.Fatalf("payload round-trip, parsed %+v err %v", parsed, err)
	}
}
