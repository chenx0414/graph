package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
)

// countingDaemon records every restart so a test can assert that a busy shell did
// not replace the background process.
type countingDaemon struct {
	supervised bool
	restarts   atomic.Int64
	starts     atomic.Int64
	adopted    atomic.Int64
	next       daemonRefresh
	startErr   error
}

func (d *countingDaemon) start() error {
	d.starts.Add(1)
	return d.startErr
}
func (d *countingDaemon) adopt(pid int)          { d.adopted.Add(1) }
func (d *countingDaemon) refresh() daemonRefresh { return d.next }
func (d *countingDaemon) restart(reload bool) (bool, string) {
	d.restarts.Add(1)
	return true, ""
}
func (d *countingDaemon) status() daemonStatus { return daemonStatus{} }

// A stale daemon is replaced on start, but only when nothing is running: the
// restart ends the operation that was in flight, and the console re-renders a turn
// that was already answered as interrupted.
func TestAStaleDaemonIsNotReplacedWhileAnOperationRuns(t *testing.T) {
	busy := &fakeBusy{}
	busy.active.Store(true)
	daemon := &countingDaemon{next: daemonRefresh{restart: true, reload: true}}
	gate := newReloadGate(busy, func(string) error { return nil })

	replaced := gate.run(func() error {
		daemon.restart(true)
		return nil
	})
	if replaced {
		t.Fatal("a daemon restart must not run while an operation is in flight")
	}
	if got := daemon.restarts.Load(); got != 0 {
		t.Fatalf("the daemon was restarted %d time(s) while work was running", got)
	}
	if !gate.pending() {
		t.Fatal("the restart must be remembered so the new daemon still comes up")
	}
}

// Once the work settles the held-back restart runs, and only once.
func TestAHeldBackDaemonRestartRunsOnceAfterSettling(t *testing.T) {
	busy := &fakeBusy{}
	busy.active.Store(true)
	daemon := &countingDaemon{}
	gate := newReloadGate(busy, func(string) error { return nil })

	gate.run(func() error { daemon.restart(true); return nil })
	busy.active.Store(false)
	if !gate.run(func() error { daemon.restart(true); return nil }) {
		t.Fatal("the deferred restart must run once the work settled")
	}
	gate.run(func() error { daemon.restart(true); return nil })
	if got := daemon.restarts.Load(); got != 1 {
		t.Fatalf("the daemon must be restarted exactly once, got %d", got)
	}
}

// An idle shell still replaces a stale daemon, which is what makes a rebuild take
// effect at all.
func TestAStaleDaemonIsReplacedWhenNothingRuns(t *testing.T) {
	busy := &fakeBusy{}
	daemon := &countingDaemon{}
	gate := newReloadGate(busy, func(string) error { return nil })

	if !gate.run(func() error { daemon.restart(true); return nil }) {
		t.Fatal("an idle shell must replace a stale daemon")
	}
	if got := daemon.restarts.Load(); got != 1 {
		t.Fatalf("the stale daemon must be replaced once, got %d", got)
	}
}

// ensureDaemon is the path a freshly exec'd GUI takes on start. A rebuild makes the
// daemon look stale, and the old code restarted it at once — which killed the turn
// that was still running, forty seconds after the GUI itself had been replaced with
// the same pid.
func TestEnsureDaemonHoldsTheRestartWhileWorkRuns(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	writeConsole(t, stateDir, server.URL, 4242)

	busy := &fakeBusy{}
	busy.active.Store(true)
	daemon := &countingDaemon{next: daemonRefresh{restart: true, reload: true}}
	shell := &shell{paths: Paths{StateDir: stateDir}, daemon: daemon}
	shell.gate = newReloadGate(busy, func(string) error { return nil })

	url := shell.ensureDaemon()
	if got := daemon.restarts.Load(); got != 0 {
		t.Fatalf("ensureDaemon restarted the daemon %d time(s) while work was running", got)
	}
	if url != server.URL {
		t.Fatalf("the running daemon must keep serving, got %q", url)
	}
	if !shell.gate.pending() {
		t.Fatal("the restart must stay armed so the new daemon comes up once work settles")
	}
}

// With nothing running the same call replaces the stale daemon, which is what makes
// a rebuild take effect.
func TestEnsureDaemonReplacesAStaleDaemonWhenIdle(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	writeConsole(t, stateDir, server.URL, 4242)

	busy := &fakeBusy{}
	daemon := &countingDaemon{next: daemonRefresh{restart: true, reload: true}}
	shell := &shell{paths: Paths{StateDir: stateDir}, daemon: daemon}
	shell.gate = newReloadGate(busy, func(string) error { return nil })

	shell.ensureDaemon()
	if got := daemon.restarts.Load(); got != 1 {
		t.Fatalf("an idle shell must replace the stale daemon once, got %d", got)
	}
}

func writeConsole(t *testing.T, stateDir, url string, pid int) {
	t.Helper()
	payload := []byte(`{"url":"` + url + `","pid":` + strconv.Itoa(pid) + `}`)
	if err := os.WriteFile(filepath.Join(stateDir, "console.json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A freshly exec'd GUI has no console address yet: setConsole runs later. "I have
// not read the daemon" must not read as "nothing is running", or the first thing
// the new process does is restart a stale daemon and end the turn that survived the
// rebuild — which is exactly what the real probe measured, forty seconds in.
func TestAFreshShellAsksTheDaemonItHasNotReadYet(t *testing.T) {
	stateDir := t.TempDir()
	active := 1
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"active":` + strconv.Itoa(active) + `}`))
	}))
	defer server.Close()
	writeConsole(t, stateDir, server.URL, 4242)

	shell := &shell{paths: Paths{StateDir: stateDir}}
	gate := shell.reloadGate()

	if !gate.busy.HasActiveOperation() {
		t.Fatal("a shell with no address yet must still see the work in flight")
	}
}
