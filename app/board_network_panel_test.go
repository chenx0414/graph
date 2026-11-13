package main

import "testing"

func networkPanelFleet() *fleetSnapshot {
	data := &fleetSnapshot{RootID: "g1"}
	data.Agents = []fleetAgent{
		{ID: "g1", Kind: "global", Role: "lead", Name: "Main", Status: "running", ConversationID: "g1"},
		{ID: "p1", ParentID: "g1", Kind: "project", Role: "lead", Name: "项目 A", Status: "running", ConversationID: "p1"},
		{ID: "p2", ParentID: "g1", Kind: "project", Role: "lead", Name: "项目 B", Status: "idle", ConversationID: "p2"},
		{ID: "p1-n1", ParentID: "p1", Kind: "node", Role: "worker", Name: "planner", Status: "running", TaskID: "tA", NodeID: "n2"},
	}
	data.Tasks = []fleetTask{{TaskID: "tA", ID: "tA", Title: "目标：验证编队网络", Status: "running", Phase: "executing", OwnerAgentID: "p1"}}
	return data
}

func TestTheWhiteboardNetworkShowsThreadsForMain(t *testing.T) {
	mock := &nodeChatMock{
		fleet: networkPanelFleet(),
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("g1")
	tester = frames(frames(tester))
	if !tester.HasText("2 个 Thread Agent · Main 中心") {
		t.Fatalf("the network panel lists the threads around Main, texts %q", tester.Texts())
	}
	if !tester.HasText("项目 A") || !tester.HasText("项目 B") {
		t.Fatalf("the network panel shows the thread agents, texts %q", tester.Texts())
	}
}

func TestTheWhiteboardNetworkShowsGraphsForAThread(t *testing.T) {
	mock := &nodeChatMock{
		fleet: networkPanelFleet(),
		conv: map[string]string{
			"p1": `{"messages":[{"id":"m2","seq":1,"role":"assistant","kind":"message","text":"项目线程","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("p1")
	tester = frames(frames(tester))
	if !tester.HasText("项目 A · 1 个 Graph") {
		t.Fatalf("the network panel lists the thread's graphs, texts %q", tester.Texts())
	}
	if !tester.HasText("目标：验证编队网络") {
		t.Fatalf("the network panel names the graph unit, texts %q", tester.Texts())
	}
}

func TestTheWhiteboardNetworkShowsTheGraphForAGraphAgent(t *testing.T) {
	fleet := networkPanelFleet()
	node := fleetAgent{ID: "p1-n1", ParentID: "p1", Kind: "node", Name: "planner", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet:    fleet,
		run:      `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点在干活","createdAt":1}],"hasOlder":false}`,
		topology: `{"taskId":"tA","nodes":[{"id":"n2","kind":"task","status":"running","label":"planner"}],"edges":[]}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	deadline := 3
	for index := 0; index < deadline; index++ {
		tester = frames(tester)
	}
	if !tester.HasText("图节点 planner") {
		t.Fatalf("the network panel renders the graph of the open graph agent, texts %q", tester.Texts())
	}
	if !tester.HasText("Graph · 1 节点 · 0 边") {
		t.Fatalf("the network panel captions the graph, texts %q", tester.Texts())
	}
}

func TestTheDefaultWhiteboardShowsTheNetworkBesideTheAgentPanel(t *testing.T) {
	page := defaultBoardPages()[0]
	seen := map[string]bool{}
	for _, panel := range page.Panels {
		seen[panel.Kind] = true
	}
	if !seen["agent"] || !seen["agent-network"] {
		t.Fatalf("the whiteboard leads with the agent panel and its network, panels %+v", page.Panels)
	}
	if seen["artifacts"] {
		t.Fatalf("the generic artifacts card is gone from the whiteboard, panels %+v", page.Panels)
	}
}
