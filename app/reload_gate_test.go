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

	ran := gate.run("test-restart", func() error { return relaunch.exec("/tmp/graphd") })
	if ran {
		t.Fatal("a daemon restart must wait while an operation runs")
	}
	busy.active.Store(false)
	if !gate.run("test-restart", func() error { return relaunch.exec("/tmp/graphd") }) {
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
			if r.URL.Path != "/api/app/activity" {
				http.NotFound(w, r)
				return
			}
			w.Write([]byte(`{"active":` + strconv.Itoa(active) + `}`))
		}))
		address := server.URL
		activity := daemonActivity{
			console: func() string { return address },
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

// The watcher polls the same file repeatedly. A deferred reload has to survive that
// repetition: if the watcher advanced its stamp while waiting, the next poll would
// compare the new stamp with the file it already read, see no change, and the new
// binary would never run.
func TestTheWatcherKeepsSeeingABuildItIsHoldingBack(t *testing.T) {
	busy := &fakeBusy{}
	relaunch := &fakeRelaunch{}
	gate := newReloadGate(busy, relaunch.exec)

	before := fileStamp{Size: 1, Inode: 1}
	after := fileStamp{Size: 2, Inode: 2}

	busy.active.Store(true)
	for poll := 0; poll < 3; poll++ {
		if gate.consider("/tmp/Graph", before, after) {
			t.Fatalf("poll %d replaced the process while work was running", poll)
		}
	}
	if got := relaunch.execs.Load(); got != 0 {
		t.Fatalf("nothing may run while the operation is active, got %d", got)
	}

	busy.active.Store(false)
	if !gate.consider("/tmp/Graph", before, after) {
		t.Fatal("the reload must still see the build it was holding back")
	}
	if got := relaunch.execs.Load(); got != 1 {
		t.Fatalf("the held-back build must run once, got %d", got)
	}
}

// One gate answers for every replacing path, so a daemon restart on start-up must
// not use up the reload a later build needs. The settled flag is per held action,
// not permanent: after ensureDaemon replaced a stale daemon at launch, the watcher
// still has to take the next build — and the probe measured exactly that, with the
// app mtime at 15:58 and the process from 15:55 still running forty seconds after
// the operation settled.
func TestASuccessfulRestartDoesNotCloseTheGateForLaterBuilds(t *testing.T) {
	busy := &fakeBusy{}
	relaunch := &fakeRelaunch{}
	gate := newReloadGate(busy, relaunch.exec)

	// The launch path replaces a stale daemon while nothing runs.
	if !gate.run("test-restart", func() error { return relaunch.exec("/tmp/graphd") }) {
		t.Fatal("an idle shell must replace the stale daemon at launch")
	}

	// A build lands later, with work running: it must be held, not swallowed.
	busy.active.Store(true)
	if gate.consider("/tmp/Graph", fileStamp{Size: 1}, fileStamp{Size: 2}) {
		t.Fatal("the build must wait while work runs")
	}
	if !gate.pending() {
		t.Fatal("the build must be remembered, or the new binary never runs")
	}

	// Work settles: the next poll takes the build.
	busy.active.Store(false)
	if !gate.consider("/tmp/Graph", fileStamp{Size: 1}, fileStamp{Size: 2}) {
		t.Fatal("the held build must run once the work settled")
	}
	if got := relaunch.execs.Load(); got != 2 {
		t.Fatalf("one daemon restart and one build reload, got %d", got)
	}
}

// A build is replaced once. The watcher keeps polling the same file, so without
// this the gate would hand the same replacement over and over.
func TestAFinishedBuildIsNotReplacedTwice(t *testing.T) {
	busy := &fakeBusy{}
	relaunch := &fakeRelaunch{}
	gate := newReloadGate(busy, relaunch.exec)

	before := fileStamp{Size: 1, Inode: 1}
	after := fileStamp{Size: 2, Inode: 2}
	if !gate.consider("/tmp/Graph", before, after) {
		t.Fatal("the first poll must take the build")
	}
	if gate.consider("/tmp/Graph", before, after) {
		t.Fatal("the same build must not be replaced twice")
	}
	if got := relaunch.execs.Load(); got != 1 {
		t.Fatalf("the build was replaced %d time(s)", got)
	}
}
