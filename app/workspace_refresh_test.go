package main

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestWorkspaceRefreshShowsTasksAndArtifactsWithoutANewChatMessage(t *testing.T) {
	var completed atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c1":
			status := "running"
			if completed.Load() {
				status = "completed"
			}
			_, _ = w.Write([]byte(`{"messages":[{"id":"m1","role":"assistant","text":"正在协作"}],"tasks":[{"id":"t1","request":"交付共同目标","status":"` + status + `","phase":"running"}]}`))
		case "/api/conversations/c1/artifacts":
			if completed.Load() {
				_, _ = w.Write([]byte(`{"artifacts":[{"artifactId":"a1","taskId":"t1","namespace":"results","name":"answer","version":2,"size":42}]}`))
			} else {
				_, _ = w.Write([]byte(`{"artifacts":[]}`))
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	state := newShellState(server.URL, "tok")
	state.selectConversation("c1")
	tester := newTester(func(ctx *ui.Context) {
		applyTheme(ctx)
		ui.Column(ctx).Children(func() {
			state.panelTasks(ctx)
			state.panelArtifacts(ctx)
		})
	}, 900, 700)
	frames(tester)
	if !tester.HasText("交付共同目标 · running · running") {
		t.Fatalf("initial task missing: %q", tester.Texts())
	}
	completed.Store(true)
	state.refresh()
	frames(tester)
	for _, want := range []string{"交付共同目标 · completed · running", "results/answer · v2 · 42 B"} {
		if !tester.HasText(want) {
			t.Fatalf("background work must reach the workspace without a new chat message: missing %q in %q", want, tester.Texts())
		}
	}
}

func TestWorkspaceRefreshShowsNewFleetResults(t *testing.T) {
	updated := strings.ReplaceAll(fleetSampleJSON, "返回执行结果", "1024 个执行者的结果已汇总")
	state := fleetServerShell(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(updated))
	})
	state.fleet.data, _ = parseFleet([]byte(fleetSampleJSON))
	state.fleet.conversationID = "g1"
	state.openModule("fleet")
	tester := frames(newTester(state.view, 1440, 900))
	state.refresh()
	awaitWorkspaceText(t, tester, "1024 个执行者的结果已汇总")
}

func TestFleetArtifactOpensTheSelectedVersionOutsideTheCurrentConversation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tasks/t1/artifacts/a1/2/content":
			_, _ = w.Write([]byte("精确的第二版协作成果"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	state := newShellState(server.URL, "tok")
	state.chat = newChatState(server.URL, "tok")
	state.chat.active = "g1"
	state.activeID = "g1"
	state.fleet.data, _ = parseFleet([]byte(fleetSampleJSON))
	state.fleet.conversationID = "g1"
	state.openModule("fleet")
	tester := frames(newTester(state.view, 1440, 900))
	if err := tester.Click("共享产物 docs/spec.md · v2 · 2.0 KB"); err != nil {
		t.Fatal(err)
	}
	awaitWorkspaceText(t, tester, "精确的第二版协作成果")
	if !tester.HasText("预览 · docs/spec.md · v2 · 2.0 KB") {
		t.Fatalf("the preview must identify the clicked version: %q", tester.Texts())
	}
}

func awaitWorkspaceText(t *testing.T, tester *ui.Tester, text string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		render(tester)
		if tester.HasText(text) {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("UI never reached %q: %q", text, tester.Texts())
		default:
			runtime.Gosched()
		}
	}
}

func agentPageState(t *testing.T) *shellState {
	t.Helper()
	state := fleetServerShell(t, fleetSampleServer)
	state.fleet.data, _ = parseFleet([]byte(fleetSampleJSON))
	state.fleet.conversationID = "g1"
	state.board.pages = []boardPage{{ID: "agent:" + state.fleet.data.Agents[0].ID, Title: "Agent", Kind: "agent"}}
	state.board.active = 0
	return state
}

func TestRefreshingAnAgentPageKeepsItsActivityOnScreen(t *testing.T) {
	state := agentPageState(t)
	agent := state.fleet.data.Agents[0]
	state.fleet.detail = fleetDetailEntry{agentID: agent.ID, entries: []fleetActivity{{ID: "a1", Text: "既有活动"}}}
	state.refreshVisibleWorkspace()
	if len(state.fleet.detail.entries) != 1 {
		t.Fatalf("a quiet refresh must keep the activity list, entries %+v", state.fleet.detail.entries)
	}
	if state.fleet.detail.loading {
		t.Fatal("a quiet refresh must not blank the page with a loading state")
	}
}

func TestRefreshingAGraphPageKeepsTheGraphOnScreen(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	state.board.pages = []boardPage{{ID: "graph:t1", Title: "Graph", Kind: "fleet-graph"}}
	state.board.active = 0
	state.graph = fleetGraphView{taskID: "t1", data: &fleetTopologyData{TaskID: "t1", Nodes: []fleetTopologyNode{{ID: "n0"}}}}
	state.refreshVisibleWorkspace()
	if state.graph.loading {
		t.Fatal("a quiet refresh must keep the graph on screen instead of flashing a loading state")
	}
	if state.graph.data == nil {
		t.Fatal("a quiet refresh must keep the graph data until a new snapshot arrives")
	}
}
