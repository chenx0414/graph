// graph:table-writes-exempt: a test seeds the rows the projection reads
package graph

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

// The history browser (app/fleet_history.go) asks GET /api/tasks for the whole
// task list and filters by project on the client. That endpoint is served by
// GraphApp.serveTasks -> TaskRuntimeUser.List(). The user-visible promise
// behind problem 2 -- "browse every graph of a project, not just the running
// ones, and not just the first twelve" -- only holds if the HTTP payload
// carries every phase (completed, stopped, blocked, discussing, running,
// failed) with the fields the history rows render.
//
// These tests hit the real handler (ServeHTTP) so a future cap, filter or field
// rename in the projection fails here instead of shipping a truncated history.
func seedHistoryFixture(t *testing.T) *fleetFixture {
	t.Helper()
	fixture := seedFleetFixture(t)
	// One terminal graph per phase that the old fleet panel could not show.
	rows := []string{
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('hist-completed','p1','已完成的历史图',10,'completed','c-proj')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('hist-stopped','p1','已停止的历史图',11,'stopped','c-proj')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('hist-blocked','p1','阻塞的历史图',12,'blocked','c-proj')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('hist-discussing','p1','讨论中的图',13,'discussing','c-proj')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('hist-abandoned','p1','已放弃的图',14,'abandoned','c-proj')`,
	}
	for _, query := range rows {
		fixture.exec(t, query)
	}
	return fixture
}

func (fixture *fleetFixture) tasks(t *testing.T) []map[string]any {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: fixture.app.session})
	recorder := httptest.NewRecorder()
	fixture.app.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET /api/tasks -> %d %s", recorder.Code, recorder.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode /api/tasks: %v", err)
	}
	return rows
}

func historyRowByID(rows []map[string]any, id string) map[string]any {
	for _, row := range rows {
		if kernelString(row["id"]) == id {
			return row
		}
	}
	return nil
}

// TestTaskHistoryEndpointReturnsEveryPhase proves the endpoint itself does not
// narrow the history to running/blocked graphs. Each terminal phase must be
// present in the payload the history page reads.
func TestTaskHistoryEndpointReturnsEveryPhase(t *testing.T) {
	fixture := seedHistoryFixture(t)
	rows := fixture.tasks(t)

	want := map[string]string{
		"hist-completed":  "completed",
		"hist-stopped":    "stopped",
		"hist-blocked":    "blocked",
		"hist-discussing": "discussing",
		"hist-abandoned":  "abandoned",
	}
	for id, phase := range want {
		row := historyRowByID(rows, id)
		if row == nil {
			t.Fatalf("history endpoint dropped %s (%s) -- the page cannot list it: %v", id, phase, historyIDs(rows))
		}
		if got := kernelString(row["phase"]); got != phase {
			t.Fatalf("%s reports phase %q, want %q", id, got, phase)
		}
	}
}

// TestTaskHistoryEndpointCarriesTheRenderedFields pins the exact keys the
// history row and the "open conversation" action depend on. A rename here would
// silently blank the history list because the frontend reads these names.
func TestTaskHistoryEndpointCarriesTheRenderedFields(t *testing.T) {
	fixture := seedHistoryFixture(t)
	row := historyRowByID(fixture.tasks(t), "hist-completed")
	if row == nil {
		t.Fatal("completed history graph missing from /api/tasks")
	}
	for _, key := range []string{"id", "projectId", "request", "phase", "status", "conversationId", "createdAt", "updatedAt"} {
		if _, ok := row[key]; !ok {
			t.Fatalf("history row is missing %q, the page cannot render it: %v", key, row)
		}
	}
	if kernelString(row["projectId"]) != "p1" || kernelString(row["request"]) != "已完成的历史图" {
		t.Fatalf("history row keeps its project and title, got %v", row)
	}
	if kernelString(row["conversationId"]) != "c-proj" {
		t.Fatalf("history row keeps its conversation link so it can jump to the session, got %v", row)
	}
}

// TestTaskHistoryEndpointIsNotCappedAtTwelve seeds more terminal graphs than the
// old fleet panel's 12-row cut and asserts every one of them comes back. This is
// the regression guard for "还有 N 个未列出 but you cannot continue".
func TestTaskHistoryEndpointIsNotCappedAtTwelve(t *testing.T) {
	fixture := seedHistoryFixture(t)
	const extra = 20
	for index := 0; index < extra; index++ {
		fixture.exec(t,
			`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES(?,?,?,?,?,?)`,
			"bulk-completed-"+twoDigit(index), "p1", "批量历史图", 100+index, "completed", "c-proj")
	}
	rows := fixture.tasks(t)

	completed := 0
	for _, row := range rows {
		if kernelString(row["projectId"]) == "p1" && kernelString(row["phase"]) == "completed" {
			completed++
		}
	}
	// hist-completed + the 20 bulk rows, plus t-work is 'running' so it is not counted.
	if completed != extra+1 {
		t.Fatalf("history endpoint returned %d completed p1 graphs, want %d (no 12-row cut)", completed, extra+1)
	}
	for index := 0; index < extra; index++ {
		id := "bulk-completed-" + twoDigit(index)
		if historyRowByID(rows, id) == nil {
			t.Fatalf("history endpoint dropped %s past the twelfth row: %v", id, historyIDs(rows))
		}
	}
}

func historyIDs(rows []map[string]any) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, kernelString(row["id"]))
	}
	sort.Strings(ids)
	return ids
}

func twoDigit(value int) string {
	if value < 10 {
		return "0" + string(rune('0'+value))
	}
	return string(rune('0'+value/10)) + string(rune('0'+value%10))
}
