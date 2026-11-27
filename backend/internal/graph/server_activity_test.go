// graph:table-writes-exempt: the test serves one read-only route
package graph

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A process may not be replaced while work is in flight, and it cannot know that
// from the UI: the console can look idle while an operation is dispatched. This
// route is the durable answer the reload gate asks for.
func TestActivityReportsInFlightWork(t *testing.T) {
	busy := true
	app := CreateApp(&TaskRuntime{}, AppOptions{ActiveOperations: func() int { return 1 }})
	_ = busy

	body := readActivity(t, app)
	if body.Active != 1 {
		t.Fatalf("the route must report the work in flight, got %d", body.Active)
	}
	if !body.Busy() {
		t.Fatal("one active operation means busy")
	}
}

// An idle daemon says so, and that is what lets a build replace the process at
// once instead of waiting for work that will never settle.
func TestActivityReportsIdle(t *testing.T) {
	app := CreateApp(&TaskRuntime{}, AppOptions{ActiveOperations: func() int { return 0 }})

	body := readActivity(t, app)
	if body.Active != 0 {
		t.Fatalf("an idle daemon reported %d operations", body.Active)
	}
	if body.Busy() {
		t.Fatal("zero active operations means idle")
	}
}

// A daemon that declares no counter answers zero rather than refusing: a route
// that errors would make the gate wait forever, and every build would be lost.
func TestActivityIsIdleWhenNoCounterIsDeclared(t *testing.T) {
	app := CreateApp(&TaskRuntime{}, AppOptions{})

	body := readActivity(t, app)
	if body.Busy() {
		t.Fatalf("a daemon with no counter must read as idle, got %d", body.Active)
	}
}

func readActivity(t *testing.T, app *GraphApp) appActivity {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/activity", nil)
	recorder := httptest.NewRecorder()
	app.serveActivity(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("activity answered %d", recorder.Code)
	}
	var body appActivity
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("activity body: %v", err)
	}
	return body
}
