package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"
)

type nodeChatMock struct {
	mu     sync.Mutex
	run    string
	fail   bool
	posted []string
	fleet  *fleetSnapshot
	conv   map[string]string
}

func (m *nodeChatMock) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/fleet", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(m.fleet)
	})
	mux.HandleFunc("/api/conversations", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{})
	})
	mux.HandleFunc("/api/conversations/", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		id := r.URL.Path[len("/api/conversations/"):]
		body := m.conv[id]
		m.mu.Unlock()
		if r.Method == http.MethodPost {
			payload, _ := io.ReadAll(r.Body)
			m.mu.Lock()
			m.posted = append(m.posted, string(payload))
			m.mu.Unlock()
		}
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("/api/tasks/", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if r.Method == http.MethodPost {
			payload, _ := io.ReadAll(r.Body)
			m.posted = append(m.posted, string(payload))
			_, _ = w.Write([]byte(`{}`))
			return
		}
		_, _ = w.Write([]byte(m.run))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func nodeChatShell(t *testing.T, mock *nodeChatMock) (*shellState, *ui.Tester) {
	t.Helper()
	server := mock.server(t)
	state := fleetServerShell(t, fleetSampleServer)
	state.api = newAPIClient(server.URL, "")
	state.fleet = fleetState{conversationID: "g1", data: mock.fleet}
	tester := ui.NewTester(state.view, 1440, 900)
	return state, tester
}

func TestOpeningAgentChatReusesConversation(t *testing.T) {
	mock := &nodeChatMock{
		fleet: ringGraphFleet(),
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
			"p1": `{"messages":[{"id":"m2","seq":1,"role":"assistant","kind":"message","text":"项目线程在这里","createdAt":2}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectBoardPage(1)
	frames(tester)
	if err := tester.Click("编队 Agent Main"); err != nil {
		t.Fatalf("click the main card: %v", err)
	}
	tester = frames(tester)
	if state.activeID != "g1" || state.active() == nil {
		t.Fatalf("the main card opens its conversation, activeID %q", state.activeID)
	}
	if active := state.active(); active == nil || active.agentTitle != "Main" {
		t.Fatalf("the main chat carries the agent header, %+v", active)
	}
}

func TestOpeningNodeChatReadsAndSendsEntries(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"e1","role":"system","kind":"note","text":"节点已启动","createdAt":1},{"seq":2,"id":"e2","role":"error","kind":"error","text":"上次调用失败","createdAt":2},{"seq":3,"id":"e3","role":"assistant","kind":"message","text":"正在重做 Graph 页","createdAt":3}]}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(tester)
	active := state.active()
	if active == nil || active.active != "node:tA/n2" {
		t.Fatalf("the node chat opens with a synthetic id, %+v", active)
	}
	for _, want := range []string{"fleet-ui", "节点已启动", "上次调用失败", "正在重做 Graph 页", "详情"} {
		if !tester.HasText(want) {
			t.Fatalf("the node chat shows %q, texts %q", want, tester.Texts())
		}
	}
	state.active().sendText("继续实现")
	if len(mock.posted) == 0 || !containsString(mock.posted[0], "继续实现") || !containsString(mock.posted[0], "\"text\"") {
		t.Fatalf("sending posts the node message, posted %v", mock.posted)
	}
	if state.active().draft != "" {
		t.Fatal("sending clears the draft")
	}
}

func containsString(text, part string) bool {
	return len(text) >= len(part) && (text == part || (len(part) > 0 && indexOf(text, part) >= 0))
}

func indexOf(text, part string) int {
	for index := 0; index+len(part) <= len(text); index++ {
		if text[index:index+len(part)] == part {
			return index
		}
	}
	return -1
}

func TestNodeChatEmptyAndFailureStates(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2"}
	empty := &nodeChatMock{fleet: fleet, run: `{"entries":[]}`}
	state, _ := nodeChatShell(t, empty)
	state.openFleetAgentChat(node)
	if state.active() == nil || state.active().status == "" {
		t.Fatal("an empty node chat has a status")
	}
	failing := &nodeChatMock{fleet: fleet, fail: true}
	state, _ = nodeChatShell(t, failing)
	state.openFleetAgentChat(node)
	if state.active() == nil || state.active().status == "" {
		t.Fatal("a failing node chat has a status")
	}
}

func TestChildChatOpensWithoutSidebar(t *testing.T) {
	fleet := ringGraphFleet()
	child := fleetAgent{ID: "c1", ParentID: "p1", Kind: "child", Name: "spawn-probe", ConversationID: "c1", Status: "running"}
	fleet.Agents = append(fleet.Agents, child)
	mock := &nodeChatMock{fleet: fleet, conv: map[string]string{"c1": `{"messages":[]}`}}
	state, _ := nodeChatShell(t, mock)
	state.openFleetAgentChat(child)
	if state.activeID != "c1" || state.active() == nil || state.active().agentTitle != "spawn-probe" {
		t.Fatalf("a child opens its chat with a header, activeID %q", state.activeID)
	}
}
