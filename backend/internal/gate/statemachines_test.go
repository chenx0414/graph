// graph:table-writes-exempt: the test scans SQL fixtures; it does not write the live schema

package gate

import (
	"testing"

	"github.com/chenx0414/graph/backend/statemachine"
)

func registryFixture() []statemachine.Machine {
	return []statemachine.Machine{{
		ID: "task.phase", Title: "任务阶段", Store: "table",
		Targets: []statemachine.Target{{Table: "tasks", Column: "phase"}},
		States: []statemachine.State{
			{Name: "discussing", Label: "待确认"},
			{Name: "running", Label: "运行中"},
			{Name: "blocked", Label: "阻塞"},
		},
		Transitions: []statemachine.Transition{{From: "discussing", To: "running"}},
	}}
}

func TestCheckRegistryStatesAcceptsDeclaredEvidence(t *testing.T) {
	evidence := RegistryEvidence{
		Facts: []RegistryFact{{Table: "tasks", Column: "phase", Value: "running", File: "a.go"}},
		Edges: []RegistryEdge{{Table: "tasks", Column: "phase", From: "discussing", To: "running", File: "a.go"}},
	}
	if problems := CheckRegistryStates(evidence, registryFixture()); len(problems) != 0 {
		t.Fatalf("declared evidence reported problems: %+v", problems)
	}
}

func TestCheckRegistryStatesNamesUndeclaredState(t *testing.T) {
	evidence := RegistryEvidence{Facts: []RegistryFact{{Table: "tasks", Column: "phase", Value: "ready", File: "a.go"}}}
	problems := CheckRegistryStates(evidence, registryFixture())
	if len(problems) != 1 || problems[0].Kind != "undeclared-state" {
		t.Fatalf("want one undeclared-state problem, got %+v", problems)
	}
}

func TestCheckRegistryStatesNamesUndeclaredMachine(t *testing.T) {
	evidence := RegistryEvidence{Facts: []RegistryFact{{Table: "questions", Column: "status", Value: "open", File: "a.go"}}}
	problems := CheckRegistryStates(evidence, registryFixture())
	if len(problems) != 1 || problems[0].Kind != "undeclared-machine" {
		t.Fatalf("want one undeclared-machine problem, got %+v", problems)
	}
}

func TestCheckRegistryStatesNamesIllegalTransition(t *testing.T) {
	evidence := RegistryEvidence{Edges: []RegistryEdge{{Table: "tasks", Column: "phase", From: "running", To: "blocked", File: "a.go"}}}
	problems := CheckRegistryStates(evidence, registryFixture())
	if len(problems) != 1 || problems[0].Kind != "illegal-transition" {
		t.Fatalf("want one illegal-transition problem, got %+v", problems)
	}
}

func TestScanRegistryStatesReadsSQLTransitions(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "backend/a.go", `package a
const a = "UPDATE tasks SET phase='blocked' WHERE id=? AND phase IN ('running','idle')"
const b = "INSERT INTO kernel_queue(task_id,state) VALUES(?,'queued')"
const c = "UPDATE tasks SET x=1 WHERE o.state='bogus'"
const d = "CREATE TABLE conversation_goals_next(status TEXT CHECK(status IN ('active')))"
`)
	evidence := ScanRegistryStates(root)
	facts := map[string]bool{}
	for _, fact := range evidence.Facts {
		facts[fact.Table+"."+fact.Column+"="+fact.Value] = true
	}
	for _, want := range []string{"tasks.phase=blocked", "kernel_queue.state=queued"} {
		if !facts[want] {
			t.Fatalf("missing fact %s in %+v", want, evidence.Facts)
		}
	}
	if facts["tasks.state=bogus"] || facts["conversation_goals_next.status=active"] {
		t.Fatalf("qualified columns and shadow tables must not become facts: %+v", evidence.Facts)
	}
	edges := map[string]bool{}
	for _, edge := range evidence.Edges {
		edges[edge.From+"->"+edge.To] = true
	}
	if !edges["running->blocked"] || !edges["idle->blocked"] {
		t.Fatalf("missing transitions in %+v", evidence.Edges)
	}
}

func TestScanRegistryStatesSkipsTestsAndGeneratedTrees(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "backend/a_test.go", `package a
const a = "UPDATE tasks SET phase='running'"`)
	writeFile(t, root, "backend/vendor/b.go", `package b
const b = "UPDATE tasks SET phase='running'"`)
	evidence := ScanRegistryStates(root)
	if len(evidence.Facts) != 0 {
		t.Fatalf("tests and vendored trees must not contribute facts: %+v", evidence.Facts)
	}
}
