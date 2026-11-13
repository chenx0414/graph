package main

import (
	"testing"
	"time"
)

func showArtifactsBoard(state *shellState) {
	page := &state.board.pages[0]
	page.Panels = append(page.Panels, boardPanel{ID: "artifacts", Kind: "artifacts"})
	page.Layout = layoutFromPanels(page.Panels)
}

func TestNodeChatFillsTheWhiteboardWithItsOwnData(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点在干活","createdAt":1}],"hasOlder":false}`,
		taskView: `{"id":"tA","request":"把这个白板接到当前 Agent","phase":"executing","status":"running",
			"nodes":[{"id":"n2","role":"worker","status":"running"},{"id":"n9","role":"reviewer","status":"idle"}]}`,
		artifact: `{"artifacts":[
			{"artifactId":"a-n2","taskId":"tA","namespace":"docs","name":"mine.md","title":"这个节点的产物","version":1,"size":10,"producer":{"nodeId":"n2"}},
			{"artifactId":"a-n9","taskId":"tA","namespace":"docs","name":"other.md","title":"别的节点的产物","version":1,"size":10,"producer":{"nodeId":"n9"}}
		]}`,
	}
	state, tester := nodeChatShell(t, mock)
	showArtifactsBoard(state)
	state.openFleetAgentChat(node)
	tester = frames(frames(tester))
	if !tester.HasText("把这个白板接到当前 Agent") {
		t.Fatalf("the tasks panel shows the node's task, texts %q", tester.Texts())
	}
	if !tester.HasText("docs/mine.md · v1 · 10 B") {
		t.Fatalf("the artifacts panel shows the node's artifacts, texts %q", tester.Texts())
	}
	if tester.HasText("docs/other.md · v1 · 10 B") {
		t.Fatalf("the artifacts panel hides other nodes' artifacts, texts %q", tester.Texts())
	}
}

func TestNodeChatAsksForItsOwnTrajectory(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点在干活","createdAt":1}],"hasOlder":false}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	frames(tester)
	state.ensureTrajectory()
	deadline := time.Now().Add(2 * time.Second)
	for state.trajectory.scopeKey == "" && time.Now().Before(deadline) {
		frames(tester)
	}
	if state.trajectory.scopeKey != "node:tA/n2" {
		t.Fatalf("the trajectory follows the node scope, state %+v", state.trajectory)
	}
	mock.mu.Lock()
	asked := append([]string(nil), mock.asked...)
	mock.mu.Unlock()
	found := false
	for _, path := range asked {
		if path == "/api/tasks/tA/nodes/n2/trajectory" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the node trajectory endpoint must be asked, asked %q", asked)
	}
}

func TestNodeChatLabelsTheWhiteboardPanelsWithItsAgent(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点在干活","createdAt":1}],"hasOlder":false}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(frames(tester))
	if !tester.HasText("当前 Agent · fleet-ui") {
		t.Fatalf("the panels name the agent they describe, texts %q", tester.Texts())
	}
}

func TestSwitchingChatsMovesTheTrajectoryToTheNewAgent(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点在干活","createdAt":1}],"hasOlder":false}`,
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	frames(tester)
	if state.trajectory.scopeKey != "" && state.trajectory.scopeKey != "node:tA/n2" {
		t.Fatalf("the first scope is the node, got %q", state.trajectory.scopeKey)
	}
	state.selectConversation("g1")
	deadline := time.Now().Add(2 * time.Second)
	for state.trajectory.scopeKey != "conversation:g1" && time.Now().Before(deadline) {
		tester = frames(tester)
	}
	if state.trajectory.scopeKey != "conversation:g1" {
		t.Fatalf("the trajectory follows the new chat, state %+v", state.trajectory)
	}
}
