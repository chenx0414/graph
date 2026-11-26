package main

import (
	"runtime"
	"strconv"
	"strings"
	"sync"

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
	once  sync.Once
	work  chan func()
	owner uint64
	// injectable lets a test run the executor on its own goroutine.
	threaded bool
}

var shellExecutor = &uiExecutor{}

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
	return e.owner != 0 && e.owner == currentGoroutine()
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
	e.start()
	done := make(chan struct{})
	e.work <- func() { defer close(done); apply() }
	<-done
}

// readShell returns a value read on the owner. onUI cannot do this: its callback
// runs on another goroutine, so a caller filling a captured variable would read
// the zero value and take the wrong branch.
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
	onUI(nil, apply)
}

// drainUI is stepUI for the common case of "let queued work settle". onUI blocks
// its caller, so a test that only used onUI has nothing left to drain; this stays
// as the name a harness calls so the intent is readable.
func drainUI() { stepUI(func() {}) }
