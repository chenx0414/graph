package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTheDefaultWhiteboardStartsWithTheAgentPanel(t *testing.T) {
	page := defaultBoardPages()[0]
	if len(page.Panels) == 0 || page.Panels[0].Kind != "agent" {
		t.Fatalf("the whiteboard leads with the agent panel, panels %+v", page.Panels)
	}
	for _, panel := range page.Panels {
		if panel.Kind == "tasks" {
			t.Fatalf("the generic task list is gone from the default whiteboard, panels %+v", page.Panels)
		}
	}
}

func TestSavedWhiteboardsSwapTheTaskListForTheAgentPanel(t *testing.T) {
	dir := t.TempDir()
	saved := `{"version":7,"active":0,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"tasks","kind":"tasks"},{"id":"artifacts","kind":"artifacts"},
		{"id":"trajectory","kind":"trajectory"},{"id":"insights","kind":"insights"}],
		"layout":{"kind":"split","axis":"column","children":[
			{"weight":1,"node":{"kind":"split","axis":"row","children":[
				{"weight":1,"node":{"kind":"panel","panelId":"tasks"}},
				{"weight":1,"node":{"kind":"panel","panelId":"artifacts"}}]}},
			{"weight":1,"node":{"kind":"split","axis":"row","children":[
				{"weight":1,"node":{"kind":"panel","panelId":"trajectory"}},
				{"weight":1,"node":{"kind":"panel","panelId":"insights"}}]}}]}}]}`
	if err := os.WriteFile(filepath.Join(dir, "whiteboard.json"), []byte(saved), 0o600); err != nil {
		t.Fatalf("write whiteboard: %v", err)
	}
	shell := newShellState("http://127.0.0.1:1", "")
	shell.loadBoard(dir)
	page := shell.boardPage()
	if page == nil {
		t.Fatal("the whiteboard never loaded")
	}
	agentPanel := func() *boardPanel {
		for index := range page.Panels {
			if page.Panels[index].Kind == "agent" {
				return &page.Panels[index]
			}
		}
		return nil
	}()
	if agentPanel == nil {
		t.Fatalf("the saved task list becomes the agent panel, panels %+v", page.Panels)
	}
	for _, panel := range page.Panels {
		if panel.Kind == "tasks" {
			t.Fatalf("no generic task list survives the migration, panels %+v", page.Panels)
		}
	}
	ids := boardLeafIDs(&page.Layout)
	found := false
	for _, id := range ids {
		if id == agentPanel.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("the agent panel keeps its slot in the layout, leaves %q panel %+v", ids, agentPanel)
	}
}

func agentPanelFleet() *fleetSnapshot {
	data := &fleetSnapshot{RootID: "g1"}
	data.Agents = []fleetAgent{
		{ID: "g1", Kind: "global", Role: "lead", Name: "Main", Status: "running", ConversationID: "g1", Tokens: 24000},
		{ID: "p1", Kind: "project", Role: "lead", Name: "13-Graph", Status: "running", ConversationID: "p1", Tokens: 40000},
		{ID: "p1-n1", ParentID: "p1", Kind: "node", Role: "worker", Name: "planner", Status: "running", TaskID: "tA", NodeID: "n2", Tokens: 8000},
	}
	return data
}

func TestTheAgentPanelFollowsTheOpenChat(t *testing.T) {
	mock := &nodeChatMock{
		fleet: agentPanelFleet(),
		run:   `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点在干活","createdAt":1}],"hasOlder":false}`,
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("g1")
	tester = frames(frames(tester))
	if !tester.HasText("global · 全局主管") {
		t.Fatalf("the panel describes the open conversation's agent, texts %q", tester.Texts())
	}
	if tester.HasText("任务清单窗口") {
		t.Fatal("the generic task list is not on the whiteboard any more")
	}
	node := fleetAgent{ID: "p1-n1", ParentID: "p1", Kind: "node", Name: "planner", TaskID: "tA", NodeID: "n2", Status: "running"}
	state.openFleetAgentChat(node)
	tester = frames(frames(tester))
	if !tester.HasText("node · 执行节点") {
		t.Fatalf("the panel follows the node chat, texts %q", tester.Texts())
	}
}

func TestTheAgentPanelDoesNotCallAProjectTheRoot(t *testing.T) {
	data := &fleetSnapshot{RootID: "p1"}
	data.Agents = []fleetAgent{
		{ID: "p1", ParentID: "g1", Kind: "project", Role: "lead", Name: "13-Graph", Status: "running", ConversationID: "p1"},
	}
	mock := &nodeChatMock{
		fleet: data,
		conv: map[string]string{
			"p1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"项目线程","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("p1")
	tester = frames(frames(tester))
	if tester.HasText("它是编队的根。") {
		t.Fatalf("a project agent with a parent is not the root, texts %q", tester.Texts())
	}
	if !tester.HasText("父级不在当前编队范围里。") {
		t.Fatalf("the panel says the parent is outside the snapshot, texts %q", tester.Texts())
	}
}
