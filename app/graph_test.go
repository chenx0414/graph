package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

const graphConversation = `{"messages":[{"role":"assistant","text":"派了两个节点"}],"tasks":[
	{"id":"t1","request":"Harness probe","status":"completed","phase":"settle","nodes":[
		{"id":"current-model","role":"worker","kind":"agent","status":"succeeded","model":"opencode-go:deepseek","definitionVersion":"coder"},
		{"id":"gpt-5-5","role":"worker","kind":"agent","status":"failed","model":"gpt-5.5","definitionVersion":"coder"}
	]}]}`

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

func TestTheTaskModuleListsTasksAndNodes(t *testing.T) {
	rows, err := parseGraphTasks([]byte(graphConversation))
	if err != nil {
		t.Fatal(err)
	}
	state := newShellState("http://127.0.0.1:1", "tok")
	chat := newChatState("http://127.0.0.1:1", "tok")
	chat.active = "c1"
	chat.tasks = rows
	state.chat = chat
	state.activeID = "c1"
	state.board.pages = []boardPage{{ID: "board", Title: boardDefaultTitle, Panels: []boardPanel{{ID: "tasks", Kind: "tasks", Slot: 0}}}}
	tester := ui.NewTester(state.view, 1100, 760)
	frames(tester)
	for _, wanted := range []string{
		"Harness probe · completed · settle",
		"current-model · worker · succeeded · opencode-go:deepseek",
		"gpt-5-5 · worker · failed · gpt-5.5",
	} {
		if !tester.HasText(wanted) {
			t.Fatalf("the task module must show %q, texts %q", wanted, tester.Texts())
		}
	}
}
