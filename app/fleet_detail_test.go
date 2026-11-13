package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestTheAgentPageLoadsConversationHistory(t *testing.T) {
	var asked string
	state := fleetDetailShell(t, fleetSampleServer, map[string]http.HandlerFunc{
		"/api/conversations/p1/history": func(w http.ResponseWriter, r *http.Request) {
			asked = r.URL.Query().Get("limit")
			_, _ = w.Write([]byte(`{"messages":[{"id":"m1","seq":1,"role":"user","kind":"chat","text":"历史活动一","createdAt":1700000000000},{"id":"m2","seq":2,"role":"assistant","kind":"chat","text":"历史活动二","createdAt":1700000001000}]}`))
		},
	})
	openFleetTester(t, state)
	if err := state.openFleetAgentPageForTest("p1"); err != nil {
		t.Fatalf("open the agent page: %v", err)
	}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for len(state.fleet.detail.entries) == 0 {
		if !time.Now().Before(deadline) {
			t.Fatalf("the agent history never landed, texts %q", tester.Texts())
		}
		tester.Frame()
	}
	tester = frames(tester)
	if asked != "40" {
		t.Fatalf("the agent page asks for the last 40 entries, asked %q", asked)
	}
	if !tester.HasText("历史活动一") || !tester.HasText("历史活动二") {
		t.Fatalf("the agent page renders the conversation history, texts %q", tester.Texts())
	}
}

func TestTheAgentPageLoadsNodeRunEntries(t *testing.T) {
	var asked string
	state := fleetDetailShell(t, fleetSampleServer, map[string]http.HandlerFunc{
		"/api/tasks/t1/nodes/worker/run": func(w http.ResponseWriter, r *http.Request) {
			asked = r.URL.Query().Get("limit")
			_, _ = w.Write([]byte(`{"taskId":"t1","nodeId":"worker","entries":[{"seq":1,"id":"e1","role":"assistant","kind":"message","text":"节点执行记录","createdAt":1700000000000}],"entryCount":1}`))
		},
	})
	state.fleet = fleetState{conversationID: "g1", data: &fleetSnapshot{RootID: "p1", Stats: fleetStats{Agents: 2}, Agents: []fleetAgent{
		{ID: "p1", Kind: "project", Name: "13-Graph", ConversationID: "p1", Status: "running"},
		{ID: "n2", ParentID: "p1", Kind: "node", Name: "worker", TaskID: "t1", NodeID: "worker", Status: "running"},
	}}}
	state.selectBoardPage(1)
	if err := state.openFleetAgentPageForTest("n2"); err != nil {
		t.Fatalf("open the agent page: %v", err)
	}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for len(state.fleet.detail.entries) == 0 {
		if !time.Now().Before(deadline) {
			t.Fatalf("the node run never landed, texts %q", tester.Texts())
		}
		tester.Frame()
	}
	tester = frames(tester)
	if asked != "40" {
		t.Fatalf("the agent page asks for the last 40 node entries, asked %q", asked)
	}
	if !tester.HasText("节点执行记录") {
		t.Fatalf("the agent page renders the node run entries, texts %q", tester.Texts())
	}
}

func TestTheAgentPageFallsBackToTheGlobalFleet(t *testing.T) {
	var globalAsked bool
	global := `{"rootId":"g1","truncated":false,"stats":{"agents":1,"running":1,"tasks":0,"messages":0,"tokens":0,"cost":0},"agents":[{"id":"g9","kind":"global","role":"lead","name":"孤儿 Agent","conversationId":"g9","status":"running"}],"links":[],"tasks":[],"events":[],"artifacts":[]}`
	state := fleetDetailShell(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(fleetSampleJSON))
	}, map[string]http.HandlerFunc{
		"/api/fleet": func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("conversationId") == "" {
				globalAsked = true
				_, _ = w.Write([]byte(global))
				return
			}
			_, _ = w.Write([]byte(fleetSampleJSON))
		},
		"/api/conversations/g9/history": func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"messages":[{"id":"m1","role":"assistant","text":"孤儿的历史","createdAt":1700000000000}]}`))
		},
	})
	openFleetTester(t, state)
	state.fleet.data = &fleetSnapshot{RootID: "p1", Agents: []fleetAgent{{ID: "p1", Kind: "project", Name: "13-Graph", ConversationID: "p1"}}}
	if err := state.openFleetAgentPageForTest("g9"); err != nil {
		t.Fatalf("open the missing agent page: %v", err)
	}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for !tester.HasText("孤儿 Agent") {
		if !time.Now().Before(deadline) {
			t.Fatalf("the page never fell back to the global fleet, texts %q", tester.Texts())
		}
		tester.Frame()
		tester = frames(tester)
	}
	if !globalAsked {
		t.Fatal("the page must ask the unscoped fleet once the scoped snapshot misses the agent")
	}
}

func TestTheAgentPageExplainsAMissingAgent(t *testing.T) {
	state := fleetDetailShell(t, fleetSampleServer, nil)
	openFleetTester(t, state)
	state.fleet.data = &fleetSnapshot{RootID: "p1", Agents: []fleetAgent{{ID: "p1", Kind: "project", Name: "13-Graph", ConversationID: "p1"}}}
	state.fleet.global = &fleetSnapshot{RootID: "g1", Agents: []fleetAgent{{ID: "g1", Kind: "global", Name: "主控"}}}
	if err := state.openFleetAgentPageForTest("missing"); err != nil {
		t.Fatalf("open the missing agent page: %v", err)
	}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if !tester.HasText("找不到这个 Agent") {
		t.Fatalf("the agent page explains a missing agent, texts %q", tester.Texts())
	}
}

func TestTheAgentPageSurvivesARestart(t *testing.T) {
	directory := t.TempDir()
	payload, err := json.Marshal(boardFile{Version: boardLayoutVersion, Active: 2, Pages: []boardPage{
		defaultBoardPage(),
		defaultFleetPage(),
		{ID: "agent:n2", Title: "worker", Kind: "agent", Panels: []boardPanel{{ID: "agent-detail", Kind: "agent-detail"}}, Layout: boardNode{Kind: "panel", PanelID: "agent-detail"}},
	}})
	if err != nil {
		t.Fatalf("encode the board: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "whiteboard.json"), payload, 0o600); err != nil {
		t.Fatalf("write the board: %v", err)
	}
	state := fleetDetailShell(t, fleetSampleServer, map[string]http.HandlerFunc{
		"/api/tasks/t1/nodes/worker/run": func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"entries":[{"seq":1,"id":"e1","role":"assistant","kind":"message","text":"重启后的记录","createdAt":1700000000000}]}`))
		},
	})
	state.fleet = fleetState{conversationID: "g1", data: &fleetSnapshot{RootID: "p1", Agents: []fleetAgent{
		{ID: "p1", Kind: "project", Name: "13-Graph", ConversationID: "p1"},
		{ID: "n2", ParentID: "p1", Kind: "node", Name: "worker", TaskID: "t1", NodeID: "worker", Status: "running"},
	}}}
	state.loadBoard(directory)
	if page := state.boardPage(); page.ID != "agent:n2" || page.Kind != "agent" {
		t.Fatalf("the saved agent page is restored, page %+v", page)
	}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	deadline := time.Now().Add(2 * time.Second)
	for len(state.fleet.detail.entries) == 0 {
		if !time.Now().Before(deadline) {
			t.Fatalf("the restored agent page never loaded, texts %q", tester.Texts())
		}
		tester.Frame()
	}
	tester = frames(tester)
	if !tester.HasText("重启后的记录") {
		t.Fatalf("the restored agent page renders its entries, texts %q", tester.Texts())
	}
}

func TestTheAgentActivityParsers(t *testing.T) {
	history, err := parseFleetHistory([]byte(`{"messages":[{"id":"m1","role":"user","kind":"chat","text":"开始","createdAt":5},{"id":"m2","role":"assistant","kind":"chat","text":"完成","createdAt":6}]}`))
	if err != nil || len(history) != 2 || history[0].Text != "开始" || history[1].At != 6 {
		t.Fatalf("history %+v err %v", history, err)
	}
	if _, err := parseFleetHistory([]byte(`{"messages":`)); err == nil {
		t.Fatal("broken history JSON must not parse")
	}
	entries, err := parseFleetNodeRun([]byte(`{"entries":[{"seq":1,"id":"e1","role":"assistant","kind":"message","text":"执行","createdAt":7}]}`))
	if err != nil || len(entries) != 1 || entries[0].Text != "执行" || entries[0].At != 7 {
		t.Fatalf("node run %+v err %v", entries, err)
	}
	if _, err := parseFleetNodeRun([]byte(`{"entries":`)); err == nil {
		t.Fatal("broken node run JSON must not parse")
	}
}

func fleetDetailShell(t *testing.T, fleet http.HandlerFunc, extra map[string]http.HandlerFunc) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for prefix, handler := range extra {
			if strings.HasPrefix(r.URL.Path, prefix) {
				handler(w, r)
				return
			}
		}
		switch {
		case r.URL.Path == "/api/conversations":
			_, _ = w.Write([]byte(`[
				{"id":"g1","title":"Main","role":"global","archivedAt":null},
				{"id":"p1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null}
			]`))
		case r.URL.Path == "/api/fleet":
			fleet(w, r)
		case strings.HasPrefix(r.URL.Path, "/api/conversations/"):
			_, _ = w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话"}]}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	state := newShellState(server.URL, "tok")
	state.load()
	return state
}

func (s *shellState) openFleetAgentPageForTest(agentID string) error {
	for index := range s.board.pages {
		if s.board.pages[index].ID == "agent:"+agentID {
			s.selectBoardPage(index)
			return nil
		}
	}
	if agent, ok := fleetAgentByID(s.fleet.data, agentID); ok {
		return s.openFleetAgentPage(agent)
	}
	if agent, ok := fleetAgentByID(s.fleet.global, agentID); ok {
		return s.openFleetAgentPage(agent)
	}
	return s.openFleetAgentPage(fleetAgent{ID: agentID, Name: agentID})
}
func TestTheAgentPageReusesItsTabAndKeepsLongTitlesShort(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	long := strings.Repeat("超长Agent名称", 8)
	state.fleet = fleetState{conversationID: "g1", data: &fleetSnapshot{RootID: "g1", Agents: []fleetAgent{
		{ID: "p1", Kind: "project", Name: long, ConversationID: "p1", Status: "running"},
	}}}
	state.selectBoardPage(1)
	if err := state.openFleetAgentPageForTest("p1"); err != nil {
		t.Fatalf("open the agent page: %v", err)
	}
	pages := len(state.board.pages)
	if err := state.openFleetAgentPageForTest("p1"); err != nil {
		t.Fatalf("reopen the agent page: %v", err)
	}
	if len(state.board.pages) != pages {
		t.Fatalf("a second click reuses the open agent page, pages %d then %d", pages, len(state.board.pages))
	}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	tab, ok := tester.Find("标签页 " + long)
	if !ok {
		t.Fatalf("the long agent tab never rendered, texts %q", tester.Texts())
	}
	if tab.W > 170 {
		t.Fatalf("the agent tab keeps its title short, width %.1f", tab.W)
	}
}
