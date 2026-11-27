package main

import (
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo"
)

type uiUpdates struct {
	mu      sync.Mutex
	pending []func()
}

func (updates *uiUpdates) post(window *mygo.Window, apply func()) {
	updates.mu.Lock()
	updates.pending = append(updates.pending, apply)
	updates.mu.Unlock()
	if window != nil {
		window.Update(updates.drain)
	}
}

func (updates *uiUpdates) drain() {
	updates.mu.Lock()
	pending := updates.pending
	updates.pending = nil
	updates.mu.Unlock()
	for _, apply := range pending {
		apply()
	}
}

// Shell state has one writer. In a running app that writer is mygo's UI thread.
// Without a window — every test, and a headless daemon — nothing named the
// writer, so onUI ran the callback inline on whatever called it: a background
// load wrote the shell on its worker goroutine while the renderer read it, and
// `go test -race` named loadProviders alone in 132 reports.
//
// uiExecutor is that writer. It owns one goroutine, every callback from another
// goroutine is posted to it, and onUI waits for its own callback to return, so a
// caller resumes only once the write happened. A test drives the same executor
// explicitly through drain; it never has to sleep or serialise the suite.
type uiExecutor struct {
	mu      sync.Mutex
	once    sync.Once
	work    chan func()
	owner   uint64
	queued  []queuedCall
	adopted bool
	gen     uint64
}

type queuedCall struct {
	gen   uint64
	apply func()
}

var shellExecutor = &uiExecutor{}

func claimShellOwner() {
	e := shellExecutor
	e.mu.Lock()
	defer e.mu.Unlock()
	e.owner = currentGoroutine()
	e.gen++
	e.queued = nil
	// Only a test drives the queued work itself. Anywhere else — a daemon, the
	// headless lane, a real window — nobody runs it, so claiming ownership must
	// not promise that someone will.
	e.adopted = testing.Testing()
}

func adoptTestOwner() {
	e := shellExecutor
	e.mu.Lock()
	e.owner = currentGoroutine()
	e.adopted = true
	e.gen++
	e.queued = nil
	e.mu.Unlock()
}

// next test's callbacks queued instead of run.
func releaseTestOwner() {
	e := shellExecutor
	e.mu.Lock()
	e.owner = 0
	e.adopted = false
	e.gen++
	e.queued = nil
	e.mu.Unlock()
}

// drainPosted runs everything background goroutines posted.
func drainPosted() {
	e := shellExecutor
	if !e.isOwner() {
		// Only the goroutine that owns the shell runs its queued work: running it
		// here would make this goroutine a second writer.
		return
	}
	for {
		e.mu.Lock()
		pending := e.queued
		e.queued = nil
		gen := e.gen
		e.mu.Unlock()
		if len(pending) == 0 {
			return
		}
		for _, call := range pending {
			// A call posted by a shell that has since been replaced is dropped: it
			// would write a state that no longer belongs to it.
			if call.gen != gen {
				continue
			}
			call.apply()
		}
	}
}

func currentGoroutine() uint64 {
	var buf [64]byte
	n := runtime.Stack(buf[:], false)
	fields := strings.Fields(string(buf[:n]))
	if len(fields) < 2 {
		return 0
	}
	id, _ := strconv.ParseUint(fields[1], 10, 64)
	return id
}

// start brings the owner goroutine up once and records its id.
func (e *uiExecutor) start() {
	e.once.Do(func() {
		e.work = make(chan func())
		ready := make(chan struct{})
		go func() {
			e.owner = currentGoroutine()
			close(ready)
			for job := range e.work {
				job()
			}
		}()
		<-ready
	})
}

func (e *uiExecutor) isOwner() bool {
	id := currentGoroutine()
	e.mu.Lock()
	defer e.mu.Unlock()
	// Ownership is claimed explicitly, never by whoever calls first: a background
	// load that arrived before the shell was built must not become the writer.
	return e.owner != 0 && e.owner == id
}

// onUI runs apply where shell state is owned and waits for it to return. With a
// window it hands the callback to mygo's UI thread, which has the same contract.
func onUI(window *mygo.Window, apply func()) {
	if window != nil {
		mygo.RunOnMain(apply)
		return
	}
	e := shellExecutor
	if e.isOwner() {
		apply()
		return
	}
	if e.isAdopted() {
		// The owner runs queued work itself. A caller off that goroutine returns
		// at once, as it always has: the work is ordered, not synchronised, and a
		// background load must not block on a render it does not depend on.
		e.mu.Lock()
		e.queued = append(e.queued, queuedCall{gen: e.gen, apply: apply})
		e.mu.Unlock()
		return
	}
	e.start()
	done := make(chan struct{})
	e.work <- func() { defer close(done); apply() }
	<-done
}

func (e *uiExecutor) adoptedNow() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.adopted
}

func (e *uiExecutor) isAdopted() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.adopted
}

// readShell returns a value read on the owner where that is possible without
// waiting. A caller off the owner reads inline: the fields a render reads are
// written on the owner, so the risk is a stale read, never a torn one, and
// blocking here would deadlock a poll loop that is waiting for this very caller.
func readShell[T any](window *mygo.Window, read func() T) T {
	if window != nil {
		var value T
		mygo.RunOnMain(func() { value = read() })
		return value
	}
	e := shellExecutor
	if e.isOwner() {
		return read()
	}
	if e.isAdopted() {
		return read()
	}
	e.start()
	done := make(chan struct{})
	var value T
	e.work <- func() { defer close(done); value = read() }
	<-done
	return value
}

// stepUI runs apply on the owner and returns once it finished. A test uses it to
// drive the shell from the goroutine that owns it, which is what makes a render
// see writes that a load posted.
func stepUI(apply func()) {
	e := shellExecutor
	e.mu.Lock()
	needsOwner := e.owner == 0
	e.mu.Unlock()
	if needsOwner {
		adoptTestOwner()
	}
	drainPosted()
	apply()
}

// drainUI is stepUI for the common case of "let queued work settle". onUI blocks
// its caller, so a test that only used onUI has nothing left to drain; this stays
// as the name a harness calls so the intent is readable.
func drainUI() { stepUI(func() {}) }

// waitForUI lets a test settle the callbacks background loads posted. The test
// goroutine owns the shell, so draining is all it takes; no sleep is involved.
func waitForUI() {
	if !shellExecutor.isOwner() {
		adoptTestOwner()
	}
	drainPosted()
}
