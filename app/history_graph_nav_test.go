package main

import (
	"testing"
	"time"
)

// TestHistoryGraphSessionTarget checks which session a history graph row leads
// to. A node session wins over a supervisor conversation when both are present,
// matching the way a node card opens in the rest of the app.
func TestHistoryGraphSessionTarget(t *testing.T) {
	cases := []struct {
		name                 string
		conversation, taskID string
		nodeID               string
		want                 string
	}{
		{"node wins over conversation", "c1", "t1", "n1", "node"},
		{"conversation alone", "c1", "", "", "conversation"},
		{"task and node", "", "t1", "n1", "node"},
		{"empty", "", "", "", ""},
		{"task alone has no session", "", "t1", "", ""},
		{"node alone has no session", "", "", "n1", ""},
	}
	for _, tc := range cases {
		if got := historyGraphSessionTarget(tc.conversation, tc.taskID, tc.nodeID); got != tc.want {
			t.Errorf("%s: historyGraphSessionTarget(%q,%q,%q) = %q, want %q",
				tc.name, tc.conversation, tc.taskID, tc.nodeID, got, tc.want)
		}
	}
}

// TestOpenHistoryGraphSessionOpensNodeSession checks that following a history
// graph into a node actually paints that node's transcript and header.
func TestOpenHistoryGraphSessionOpensNodeSession(t *testing.T) {
	fleet := ringGraphFleet()
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"e1","role":"assistant","kind":"message","text":"节点的收尾记录","createdAt":1}]}`,
	}
	state, tester := nodeChatShell(t, mock)
	var opened bool
	stepUI(func() { opened = openHistoryGraphSession(state, "c-supervisor", "tA", "n2", "fleet-ui") })
	if !opened {
		t.Fatal("a graph row with a node must open a session")
	}
	tester = frames(tester)
	if !tester.HasText("节点的收尾记录") {
		t.Fatalf("the node transcript must be on screen, texts %q", tester.Texts())
	}
	// The header paints the agent name inside an element labelled 对话标题名 (the
	// label wins over the text in the tester's index), so the observable fact is
	// that the header is painted at all — the transcript above already proves the
	// node session is the one on screen.
	if _, ok := tester.Find("对话标题名"); !ok {
		t.Fatalf("the chat header must be painted for the node session, texts %q", tester.Texts())
	}
}

// TestOpenHistoryGraphSessionOpensConversation checks that a graph row without
// a node reaches the supervisor conversation that owns it.
func TestOpenHistoryGraphSessionOpensConversation(t *testing.T) {
	fleet := ringGraphFleet()
	mock := &nodeChatMock{
		fleet: fleet,
		conv:  map[string]string{"c-history": `{"messages":[{"role":"assistant","text":"历史图的主会话"}]}`},
	}
	state, tester := nodeChatShell(t, mock)
	opened := openHistoryGraphSession(state, "c-history", "", "", "")
	if !opened {
		t.Fatal("a graph row with a conversation must open a session")
	}
	deadline := time.Now().Add(2 * time.Second)
	for !tester.HasText("历史图的主会话") && time.Now().Before(deadline) {
		tester.Frame()
		time.Sleep(time.Millisecond)
	}
	tester = frames(tester)
	if !tester.HasText("历史图的主会话") {
		t.Fatalf("the conversation transcript must be on screen, texts %q", tester.Texts())
	}
}

// TestOpenHistoryGraphSessionNoTargetIsSafe checks the empty state: a graph row
// that never had a session must not swap the reader's current chat.
func TestOpenHistoryGraphSessionNoTargetIsSafe(t *testing.T) {
	state := newShellState("http://127.0.0.1:1", "tok")
	state.activeID = "keep-me"
	opened := openHistoryGraphSession(state, "", "", "", "")
	if opened {
		t.Fatal("a graph row without a session must report that nothing opened")
	}
	if state.activeID != "keep-me" {
		t.Fatalf("the current chat must stay put, activeID %q", state.activeID)
	}
}
