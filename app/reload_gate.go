package main

import "sync"

// reloadGate answers "may this process be replaced now", from durable evidence.
type reloadGate struct {
	mu      sync.Mutex
	busy    OperationActivity
	replace func(path string) error
	armed   bool
	settled bool
}

type OperationActivity interface {
	HasActiveOperation() bool
}

func newReloadGate(busy OperationActivity, replace func(path string) error) *reloadGate {
	return &reloadGate{busy: busy, replace: replace}
}

func (g *reloadGate) pending() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.armed && !g.settled
}

func (g *reloadGate) consider(path string, before, after fileStamp) bool {
	if !executableReplaced(before, after) {
		return false
	}
	return g.run(func() error { return g.replace(path) })
}

// run holds a replacing action while work is in flight, and runs it once later.
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
