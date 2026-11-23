// graph:table-writes-exempt: the test serves health and writes no table
package graph

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Health is what a client treats as "the daemon is ready, I can read from it". The catalog is
// filled after the listener is up, so between those two moments health used to say OK while the
// bootstrap definitions were still being published - measured on the packaged binary: 9 of 20
// runs reported health OK with 1, 2 or 3 definitions instead of 5. A client that reads the
// catalog on that signal gets a half-built one.
func TestHealthRefusesUntilTheDaemonIsReady(t *testing.T) {
	ready := false
	app := CreateApp(&TaskRuntime{}, AppOptions{Ready: func() bool { return ready }})
	if status := healthStatus(t, app); status == http.StatusOK {
		t.Fatalf("health answered %d before the daemon was ready, so a client reads a half-built catalog", status)
	}
	ready = true
	if status := healthStatus(t, app); status != http.StatusOK {
		t.Fatalf("health answered %d once the daemon was ready", status)
	}
}

// A daemon that never gates readiness keeps the answer it always gave; the gate is opt-in so the
// console and every existing caller are unaffected.
func TestHealthIsOKWhenNoReadinessIsDeclared(t *testing.T) {
	app := CreateApp(&TaskRuntime{}, AppOptions{})
	if status := healthStatus(t, app); status != http.StatusOK {
		t.Fatalf("health answered %d for a daemon that declares no readiness", status)
	}
}

func healthStatus(t *testing.T, app *GraphApp) int {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	recorder := httptest.NewRecorder()
	app.serveHealth(recorder, request)
	return recorder.Code
}
