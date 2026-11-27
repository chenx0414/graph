package main

import "sync"

// reloadGate is the one place that answers "may this process be replaced now".
//
// A build that lands mid-turn used to replace the process through syscall.Exec,
// which ended the turn where it stood: the operation stayed dispatched and the
// daemon reported it as unknown or abandoned. The work was never at fault, so the
// fix is here rather than in each caller — no build, install or restart path may
// decide on its own that nothing is running.
//
// The verdict comes from durable state (operations that are dispatched or running
// a worker), never from how the UI looks or how long something has been quiet.
type reloadGate struct {
	mu      sync.Mutex
	busy    OperationActivity
	replace func(path string) error
	// armed remembers a reload that was held back, so the new binary still runs
	// once the work settles instead of being forgotten.
	armed   bool
	settled bool
}

// OperationActivity is the durable answer to "is work in flight". It is an
// interface so a test can drive the verdict without a daemon.
type OperationActivity interface {
	HasActiveOperation() bool
}

func newReloadGate(busy OperationActivity, replace func(path string) error) *reloadGate {
	return &reloadGate{busy: busy, replace: replace}
}

// pending reports whether a reload is waiting for the work to settle.
func (g *reloadGate) pending() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.armed && !g.settled
}

// consider takes a build that replaced the binary and reports whether the process
// was replaced. A held-back reload stays armed until the work settles, then runs
// exactly once.
func (g *reloadGate) consider(path string, before, after fileStamp) bool {
	if !executableReplaced(before, after) {
		return false
	}
	return g.run(func() error { return g.replace(path) })
}

// run performs an action that replaces something only when no work is in flight.
// Anything held back is remembered and retried by the next call.
func (g *reloadGate) run(act func() error) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.settled {
		return false
	}
	if g.busy.HasActiveOperation() {
		g.armed = true
		return false
	}
	if err := act(); err != nil {
		return false
	}
	g.settled = true
	g.armed = false
	return true
}
