package main

import "sync"

// reloadGate answers "may this process be replaced now", from durable evidence.
type reloadGate struct {
	mu      sync.Mutex
	busy    OperationActivity
	replace func(path string) error
	// armed remembers a build that was held back. served remembers the exact build
	// it was served for, so repeated polls of the same replacement do not reload
	// again — and a daemon restart at launch, which holds nothing, never uses up a
	// later build's reload.
	armed  bool
	served string
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
	return g.armed
}

func (g *reloadGate) consider(path string, before, after fileStamp) bool {
	if !executableReplaced(before, after) {
		return false
	}
	key := path + "|" + stampLabel(after)
	return g.run(key, func() error { return g.replace(path) })
}

// run holds a replacing action while work is in flight, and runs it once later.
func (g *reloadGate) run(key string, act func() error) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.served == key {
		return false
	}
	if g.busy.HasActiveOperation() {
		g.armed = true
		return false
	}
	if err := act(); err != nil {
		return false
	}
	g.served = key
	g.armed = false
	return true
}
