package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

type nodeChatMock struct {
	mu       sync.Mutex
	run      string
	runOlder map[string]string
	fail     bool
	posted   []string
	fleet    *fleetSnapshot
	conv     map[string]string
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
		if strings.Contains(r.URL.Path, "/n3/") {
			_, _ = w.Write([]byte(`{"entries":[{"seq":1,"id":"x3","role":"assistant","kind":"message","text":"这是第三个节点的记录","createdAt":3}]}`))
			return
		}
		if before := r.URL.Query().Get("before"); before != "" && m.runOlder[before] != "" {
			_, _ = w.Write([]byte(m.runOlder[before]))
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
	for _, want := range []string{"节点已启动", "上次调用失败", "正在重做 Graph 页"} {
		if !tester.HasText(want) {
			t.Fatalf("the node chat shows %q, texts %q", want, tester.Texts())
		}
	}
	if tester.HasText("详情") {
		t.Fatalf("the node chat must not paint an agent header/detail bar, texts %q", tester.Texts())
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

func TestNodeChatSourceWinsOverConversationID(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", ConversationID: "p1", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"e1","role":"assistant","kind":"message","text":"节点记录优先","createdAt":1}]}`,
		conv:  map[string]string{"p1": `{"messages":[]}`},
	}
	state, _ := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	active := state.active()
	if active == nil || active.active != "node:tA/n2" {
		t.Fatalf("a node agent opens the node source even with a conversation id, %+v", active)
	}
	if _, ok := active.source.(*nodeChatSource); !ok {
		t.Fatalf("the node chat uses the node source, %T", active.source)
	}
	if len(active.messages) != 1 || active.messages[0].Text != "节点记录优先" {
		t.Fatalf("the node chat reads its entries, %+v", active.messages)
	}
}

func TestSwitchingNodeChatsReplacesTheActiveSource(t *testing.T) {
	fleet := ringGraphFleet()
	first := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	second := fleetAgent{ID: "p1-n3", ParentID: "p1", Kind: "node", Name: "scale-engineer", TaskID: "tA", NodeID: "n3", Status: "idle"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"e1","role":"assistant","kind":"message","text":"第一个节点的记录","createdAt":1}]}`,
	}
	state, _ := nodeChatShell(t, mock)
	state.openFleetAgentChat(first)
	state.openFleetAgentChat(second)
	active := state.active()
	if active == nil || active.active != "node:tA/n3" {
		t.Fatalf("opening another node replaces the chat, %+v", active)
	}
	if active.agentTitle != "scale-engineer" || len(active.messages) != 1 || active.messages[0].Text != "这是第三个节点的记录" {
		t.Fatalf("the second node swaps title and messages, %+v", active)
	}
	thread := fleetAgent{ID: "p1", ParentID: "g1", Kind: "project", Name: "项目 A", ConversationID: "p1", Status: "running"}
	mock.conv = map[string]string{"p1": `{"messages":[]}`}
	state.openFleetAgentChat(thread)
	if active := state.active(); active == nil || active.active != "p1" {
		t.Fatalf("conversation after node opens the conversation, %+v", active)
	}
	state.openFleetAgentChat(first)
	if active := state.active(); active == nil || active.active != "node:tA/n2" {
		t.Fatalf("node after conversation opens the node again, %+v", active)
	}
}

func TestEveryAgentChatKeepsTheConversationList(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		conv:  map[string]string{"p1": `{"messages":[{"id":"m1","role":"assistant","text":"线程消息"}]}`},
		run:   `{"entries":[{"seq":1,"id":"e1","role":"assistant","kind":"message","text":"节点消息","createdAt":1}]}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(tester)
	if !tester.HasText("会话列表标题") || !tester.HasText("main agent 会话") {
		t.Fatalf("the node chat keeps the conversation list so users can navigate back, texts %q", tester.Texts())
	}
	thread := fleetAgent{ID: "p1", ParentID: "g1", Kind: "project", Name: "项目 A", ConversationID: "p1", Status: "running"}
	state.openFleetAgentChat(thread)
	tester = frames(tester)
	if !tester.HasText("会话列表标题") || !tester.HasText("main agent 会话") {
		t.Fatalf("a conversation chat keeps the list, texts %q", tester.Texts())
	}
}

func TestFourAgentKindsShareOpenAgentChat(t *testing.T) {
	fleet := ringGraphFleet()
	child := fleetAgent{ID: "c1", ParentID: "p1", Kind: "child", Name: "spawn-probe", ConversationID: "c1"}
	fleet.Agents = append(fleet.Agents, child)
	mock := &nodeChatMock{
		fleet: fleet,
		conv: map[string]string{
			"g1": `{"messages":[]}`,
			"p1": `{"messages":[]}`,
			"c1": `{"messages":[]}`,
		},
		run: `{"entries":[]}`,
	}
	state, _ := nodeChatShell(t, mock)
	agents := []fleetAgent{
		{ID: "g1", Kind: "global", Name: "Main", ConversationID: "g1"},
		{ID: "p1", Kind: "project", Name: "项目 A", ConversationID: "p1"},
		child,
		{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2"},
	}
	want := []string{"g1", "p1", "c1", "node:tA/n2"}
	for index, agent := range agents {
		state.openFleetAgentChat(agent)
		if active := state.active(); active == nil || active.active != want[index] {
			t.Fatalf("%s opens %q, got %+v", agent.Kind, want[index], active)
		}
	}
}

func TestNodeChatLoadsOlderEntriesWhenScrollingUp(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":20,"id":"e20","role":"assistant","kind":"message","text":"最新记录","createdAt":20}],"hasOlder":true}`,
		runOlder: map[string]string{
			"20": `{"entries":[{"seq":5,"id":"e5","role":"assistant","kind":"message","text":"更早的记录","createdAt":5}],"hasOlder":false}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(tester)
	active := state.active()
	if active == nil {
		t.Fatal("the node chat never opened")
	}
	active.ensureHistory()
	deadline := time.Now().Add(2 * time.Second)
	for !tester.HasText("更早的记录") && time.Now().Before(deadline) {
		tester = frames(tester)
	}
	if !tester.HasText("更早的记录") || !tester.HasText("最新记录") {
		t.Fatalf("scrolling up must prepend older entries, texts %q", tester.Texts())
	}
	if !state.active().noMoreHistory {
		t.Fatal("the last page must stop further history loading")
	}
}

func TestNodeChatLoadsPastAToolOnlyTailUntilItFindsAMessage(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":30,"id":"t30","role":"tool","kind":"call","text":"tool tail","createdAt":30}],"hasOlder":true}`,
		runOlder: map[string]string{
			"30": `{"entries":[{"seq":20,"id":"a20","role":"assistant","kind":"message","text":"真正的回答在前面","createdAt":20}],"hasOlder":false}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(tester)
	if !tester.HasText("真正的回答在前面") {
		t.Fatalf("the initial node chat must page past a tool-only tail to its message, texts %q", tester.Texts())
	}
	if !tester.HasText("▸ 1 次调用 · 进行中") {
		t.Fatalf("the tool tail stays available as a collapsed run, texts %q", tester.Texts())
	}
}

func TestRightClickingAnAgentCardOpensItsDetailPage(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	if err := tester.RightClick("编队 Agent 主控"); err != nil {
		t.Fatalf("open the agent card menu: %v", err)
	}
	menu := tester.Menu()
	found := false
	for _, item := range menu {
		if item == "查看详情" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the agent card menu misses the detail entry, menu %q", menu)
	}
	if err := tester.ChooseMenuItem("查看详情"); err != nil {
		t.Fatalf("choose detail: %v", err)
	}
	frames(tester)
	if page := state.boardPage(); page.ID != "agent:g1" {
		t.Fatalf("the detail entry opens the agent page, page %+v", page)
	}
}

func TestNodeChatMarksFinishedToolRunsAsDone(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "stopped"}
	mock := &nodeChatMock{
		fleet: fleet,
		run: `{"entries":[
			{"seq":1,"id":"c1","role":"tool","kind":"call","text":"{\"name\":\"bash\"}","createdAt":1,"data":{"toolCallId":"call-1","toolName":"bash"}},
			{"seq":2,"id":"r1","role":"tool","kind":"result","text":"ok","createdAt":2,"data":{"toolCallId":"call-1","toolName":"bash","isError":false}}
		],"hasOlder":false}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(tester)
	for _, text := range tester.Texts() {
		if strings.HasPrefix(text, "▸") && strings.Contains(text, "进行中") {
			t.Fatalf("a finished tool run must not read as running, texts %q", tester.Texts())
		}
	}
}

func TestNodeChatMarksAnUnansweredToolCallAsRunning(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run: `{"entries":[
			{"seq":1,"id":"c1","role":"tool","kind":"call","text":"{\"name\":\"bash\"}","createdAt":1,"data":{"toolCallId":"call-1","toolName":"bash"}}
		],"hasOlder":false}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(tester)
	found := false
	for _, text := range tester.Texts() {
		if strings.HasPrefix(text, "▸") && strings.Contains(text, "进行中") {
			found = true
		}
	}
	if !found {
		t.Fatalf("an unanswered tool call reads as running, texts %q", tester.Texts())
	}
}

func TestNodeChatLoadsOlderPagesWhenTheFirstPageFitsTheViewport(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "stopped"}
	mock := &nodeChatMock{
		fleet: fleet,
		run: `{"entries":[
			{"seq":50,"id":"a50","role":"assistant","kind":"message","text":"最后一页的回答","createdAt":50},
			{"seq":51,"id":"c51","role":"tool","kind":"call","text":"{\"name\":\"bash\"}","createdAt":51,"data":{"toolCallId":"call-51","toolName":"bash"}}
		],"hasOlder":true}`,
		runOlder: map[string]string{
			"50": `{"entries":[{"seq":10,"id":"u10","role":"user","kind":"message","text":"更早的请求","createdAt":10}],"hasOlder":false}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	deadline := time.Now().Add(3 * time.Second)
	for !tester.HasText("更早的请求") && time.Now().Before(deadline) {
		tester = frames(tester)
	}
	if !tester.HasText("更早的请求") {
		t.Fatalf("a node page that fits the viewport must keep loading older pages, texts %q", tester.Texts())
	}
}

func TestNodeChatSaysWhenTheHistoryStarts(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "stopped"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点唯一的记录","createdAt":1}],"hasOlder":false}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(frames(tester))
	if !tester.HasText("已经是最早的记录") {
		t.Fatalf("a fully loaded node chat says where its history starts, texts %q", tester.Texts())
	}
}
