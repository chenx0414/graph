package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// reloadVerdict is what one poll decides. It is the whole contract of this file:
// a build that lands while work is running waits, and the wait ends exactly once.
type fakeBusy struct {
	active atomic.Bool
	polls  atomic.Int64
}

func (f *fakeBusy) HasActiveOperation() bool {
	f.polls.Add(1)
	return f.active.Load()
}

type fakeRelaunch struct {
	execs atomic.Int64
}

func (f *fakeRelaunch) exec(path string) error {
	f.execs.Add(1)
	return nil
}

// A build that replaces the binary while an operation is running must not replace
// the process: the Exec is what turns a live turn into an abandoned one.
func TestAReplacedBinaryWaitsWhileAnOperationRuns(t *testing.T) {
	busy := &fakeBusy{}
	busy.active.Store(true)
	relaunch := &fakeRelaunch{}
	gate := newReloadGate(busy, relaunch.exec)

	if reload := gate.consider("/tmp/Graph", fileStamp{Size: 1}, fileStamp{Size: 2}); reload {
		t.Fatalf("the process must not be replaced while an operation runs, polls %d", busy.polls.Load())
	}
	if got := relaunch.execs.Load(); got != 0 {
		t.Fatalf("the binary was replaced %d time(s) while work was running", got)
	}
	if !gate.pending() {
		t.Fatal("the reload must be remembered, or the new binary never runs")
	}
}

// Once the work settles the deferred reload runs, and only once: a second poll
// must not replace the process again.
func TestADeferredReloadRunsExactlyOnceAfterTheWorkSettles(t *testing.T) {
	busy := &fakeBusy{}
	busy.active.Store(true)
	relaunch := &fakeRelaunch{}
	gate := newReloadGate(busy, relaunch.exec)

	gate.consider("/tmp/Graph", fileStamp{Size: 1}, fileStamp{Size: 2})
	if got := relaunch.execs.Load(); got != 0 {
		t.Fatalf("nothing may run while the operation is active, got %d", got)
	}

	busy.active.Store(false)
	if !gate.consider("/tmp/Graph", fileStamp{Size: 1}, fileStamp{Size: 2}) {
		t.Fatal("the deferred reload must run once the operation settled")
	}
	if got := relaunch.execs.Load(); got != 1 {
		t.Fatalf("the deferred reload must run exactly once, got %d", got)
	}

	// The caller keeps polling; a settled gate must not fire again.
	gate.consider("/tmp/Graph", fileStamp{Size: 1}, fileStamp{Size: 2})
	if got := relaunch.execs.Load(); got != 1 {
		t.Fatalf("a settled gate reloaded again, got %d", got)
	}
}

// With nothing running, a new build replaces the process at once: that is the
// behaviour that must survive.
func TestAReplacedBinaryReloadsAtOnceWhenNothingRuns(t *testing.T) {
	busy := &fakeBusy{}
	relaunch := &fakeRelaunch{}
	gate := newReloadGate(busy, relaunch.exec)

	if !gate.consider("/tmp/Graph", fileStamp{Size: 1}, fileStamp{Size: 2}) {
		t.Fatal("an idle shell must take the new binary")
	}
	if got := relaunch.execs.Load(); got != 1 {
		t.Fatalf("the idle shell must reload once, got %d", got)
	}
}

// An unchanged binary is not a reload, busy or idle.
func TestAnUnchangedBinaryNeverReloads(t *testing.T) {
	busy := &fakeBusy{}
	relaunch := &fakeRelaunch{}
	gate := newReloadGate(busy, relaunch.exec)

	stamp := fileStamp{Size: 1, Inode: 7, Mod: time.Unix(100, 0)}
	if gate.consider("/tmp/Graph", stamp, stamp) {
		t.Fatal("an unchanged binary is not a reload")
	}
	if got := relaunch.execs.Load(); got != 0 {
		t.Fatalf("an unchanged binary reloaded %d time(s)", got)
	}
}

// A daemon restart is the same decision: the gate is the one place that answers
// "may I replace something now", so every entry point asks it instead of
// inventing its own idea of idle.
func TestTheGateAlsoHoldsADaemonRestart(t *testing.T) {
	busy := &fakeBusy{}
	busy.active.Store(true)
	relaunch := &fakeRelaunch{}
	gate := newReloadGate(busy, relaunch.exec)

	ran := gate.run(func() error { return relaunch.exec("/tmp/graphd") })
	if ran {
		t.Fatal("a daemon restart must wait while an operation runs")
	}
	busy.active.Store(false)
	if !gate.run(func() error { return relaunch.exec("/tmp/graphd") }) {
		t.Fatal("the deferred daemon restart must run once the operation settled")
	}
	if got := relaunch.execs.Load(); got != 1 {
		t.Fatalf("the restart ran %d time(s)", got)
	}
}

// The activity source reads the daemon's durable count. A console that looks idle
// is not the answer, so the shell asks the daemon.
func TestActivitySourceReadsTheDaemonsCount(t *testing.T) {
	for _, active := range []int{0, 1, 3} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/activity" {
				http.NotFound(w, r)
				return
			}
			w.Write([]byte(`{"active":` + strconv.Itoa(active) + `}`))
		}))
		address := server.URL
		activity := daemonActivity{
			console: &address,
			token:   func() string { return "tok" },
			client:  func(a, tok string) apiClient { return newAPIClient(a, tok) },
		}
		if got, want := activity.HasActiveOperation(), active > 0; got != want {
			t.Errorf("active=%d gave busy=%v, want %v", active, got, want)
		}
		server.Close()
	}
}

// A daemon that cannot be reached must not block a build forever: nothing can be
// running if nothing answers.
func TestActivitySourceIsIdleWithoutAConsole(t *testing.T) {
	activity := daemonActivity{
		console: nil,
		token:   func() string { return "tok" },
		client:  func(a, tok string) apiClient { return newAPIClient(a, tok) },
	}
	if activity.HasActiveOperation() {
		t.Fatal("a shell with no console has no work in flight")
	}
}
