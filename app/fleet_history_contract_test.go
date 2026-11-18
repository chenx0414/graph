package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// The history browser is fed by GET /api/tasks. On the backend that payload is
// built by TaskRuntimeUser.List() in backend/internal/graph/core_task_runtime_task_view.go.
// It is an array of objects with these exact keys:
//
//	id, projectId, request, phase, status, conversationId,
//	createdAt, updatedAt, openQuestions,
//	acceptedProposalVersion, suspendedQuestions
//
// conversationId/createdAt/updatedAt can be JSON null. The frontend parser in
// fleet_history.go must accept all of that without dropping a task, because
// the user must be able to browse the whole history of a project, including
// completed and stopped graphs.
const backendTaskListContractSample = `[
  {"id":"hist-1","projectId":"alpha","request":"完成的历史图","phase":"completed","status":"completed",
   "conversationId":"conv-1","createdAt":1700000000000,"updatedAt":1700000060000,
   "openQuestions":0,"acceptedProposalVersion":3,"suspendedQuestions":0},
  {"id":"hist-2","projectId":"alpha","request":"停止的历史图","phase":"stopped","status":"stopped",
   "conversationId":"conv-2","createdAt":1700000100000,"updatedAt":1700000160000,
   "openQuestions":0,"acceptedProposalVersion":1,"suspendedQuestions":0},
  {"id":"hist-3","projectId":"alpha","request":"阻塞但仍在历史中","phase":"executing","status":"blocked",
   "conversationId":null,"createdAt":null,"updatedAt":null,
   "openQuestions":1,"acceptedProposalVersion":0,"suspendedQuestions":0},
  {"id":"hist-4","projectId":"alpha","request":"讨论中的任务","phase":"discussing","status":"running",
   "conversationId":"conv-4","createdAt":1700000200000,"updatedAt":1700000260000,
   "openQuestions":0,"acceptedProposalVersion":0,"suspendedQuestions":0},
  {"id":"hist-5","projectId":"beta","request":"另一个项目","phase":"failed","status":"failed",
   "conversationId":"conv-5","createdAt":1700000300000,"updatedAt":1700000360000,
   "openQuestions":0,"acceptedProposalVersion":2,"suspendedQuestions":0}
]`

// TestBackendTaskListContractParsesEveryField the boundary between the Go
// backend and the Go UI: a payload shaped exactly like TaskRuntimeUser.List()
// must reach the history browser with the fields the user reads on screen --
// title, phase, status, conversation link and timestamps.
func TestBackendTaskListContractParsesEveryField(t *testing.T) {
	tasks, err := parseHistoryGraphs([]byte(backendTaskListContractSample))
	if err != nil {
		t.Fatalf("the frontend cannot parse the backend /api/tasks shape: %v", err)
	}
	if len(tasks) != 5 {
		t.Fatalf("every backend row becomes a history row, got %d want 5", len(tasks))
	}
	byID := map[string]historyGraph{}
	for _, task := range tasks {
		byID[task.ID] = task
	}
	cases := []struct {
		id, project, request, phase, status, conversation string
	}{
		{"hist-1", "alpha", "完成的历史图", "completed", "completed", "conv-1"},
		{"hist-2", "alpha", "停止的历史图", "stopped", "stopped", "conv-2"},
		{"hist-3", "alpha", "阻塞但仍在历史中", "executing", "blocked", ""},
		{"hist-4", "alpha", "讨论中的任务", "discussing", "running", "conv-4"},
		{"hist-5", "beta", "另一个项目", "failed", "failed", "conv-5"},
	}
	for _, want := range cases {
		got, ok := byID[want.id]
		if !ok {
			t.Fatalf("backend row %s missing from parsed history", want.id)
		}
		if got.ProjectID != want.project || got.Request != want.request ||
			got.Phase != want.phase || got.Status != want.status ||
			got.ConversationID != want.conversation {
			t.Fatalf("backend row %s changed across the contract: %+v", want.id, got)
		}
	}
	if byID["hist-1"].CreatedAt != 1700000000000 || byID["hist-1"].UpdatedAt != 1700000060000 {
		t.Fatalf("timestamps survive the contract, got %+v", byID["hist-1"])
	}
	if byID["hist-3"].CreatedAt != 0 || byID["hist-3"].UpdatedAt != 0 {
		t.Fatalf("null timestamps become empty, not a parse error, got %+v", byID["hist-3"])
	}
}

// TestBackendTaskListContractKeepsTerminalPhases the user asked for completed
// and stopped graphs to be visible. The backend emits them as ordinary rows;
// the frontend must not filter them out while parsing.
func TestBackendTaskListContractKeepsTerminalPhases(t *testing.T) {
	tasks, err := parseHistoryGraphs([]byte(backendTaskListContractSample))
	if err != nil {
		t.Fatal(err)
	}
	phases := map[string]bool{}
	for _, task := range tasks {
		phases[task.Phase] = true
	}
	for _, phase := range []string{"completed", "stopped", "executing", "discussing", "failed"} {
		if !phases[phase] {
			t.Fatalf("phase %q from the backend is missing from history, phases %v", phase, phases)
		}
	}
	alpha := historyGraphsOfProject(tasks, "alpha")
	if len(alpha) != 4 {
		t.Fatalf("project alpha keeps all four of its graphs, got %d", len(alpha))
	}
}

// TestBackendTaskListContractNoTwelveRowCut the 12-row cut was the original
// complaint. A project with more than twelve rows must come through whole.
func TestBackendTaskListContractNoTwelveRowCut(t *testing.T) {
	rows := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		id := "t" + strconv.Itoa(i)
		rows = append(rows, `{"id":"`+id+`","projectId":"big","request":"图`+id+`","phase":"completed","status":"completed","conversationId":null,"createdAt":1,"updatedAt":`+strconv.Itoa(i+1)+`,"openQuestions":0}`)
	}
	payload := []byte("[" + strings.Join(rows, ",") + "]")
	tasks, err := parseHistoryGraphs(payload)
	if err != nil {
		t.Fatalf("parse 20 backend rows: %v", err)
	}
	if len(tasks) != 20 {
		t.Fatalf("all 20 graphs survive the contract, got %d", len(tasks))
	}
	big := historyGraphsOfProject(tasks, "big")
	if len(big) != 20 {
		t.Fatalf("the history browser shows all 20 of a project's graphs, got %d", len(big))
	}
}

// TestBackendTaskListContractMarshalRoundTrip guards the other direction too:
// a history row the UI holds can marshal back to the exact key set the backend
// client expects, so a refresh does not silently rename a field.
func TestBackendTaskListContractMarshalRoundTrip(t *testing.T) {
	original := historyGraph{
		ID: "rt-1", ProjectID: "alpha", Request: "往返", Phase: "completed",
		Status: "completed", ConversationID: "conv-rt", CreatedAt: 12, UpdatedAt: 34,
		OpenQuestions: 0,
	}
	payload, err := json.Marshal([]historyGraph{original})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseHistoryGraphs(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed) != 1 || parsed[0] != original {
		t.Fatalf("history row survives a JSON round trip, got %+v", parsed)
	}
}
