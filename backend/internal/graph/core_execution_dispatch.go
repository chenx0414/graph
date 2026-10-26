package graph

import (
	"sync"
	"time"
)

// RunReady dispatches every currently ready node and waits for them.
func (e *Execution) RunReady() ExecutionDispatch {
	nodes := e.readyNodes()
	results := make([]bool, len(nodes))
	failures := make([]any, 0)
	var failuresMu sync.Mutex
	var wait sync.WaitGroup
	for index, node := range nodes {
		wait.Add(1)
		go func(index int, node ExecutionNodeRow) {
			defer wait.Done()
			ok, failure := e.run(node)
			results[index] = ok
			if failure != nil {
				failuresMu.Lock()
				failures = append(failures, failure)
				failuresMu.Unlock()
			}
		}(index, node)
	}
	wait.Wait()
	if len(failures) > 0 {
		panic(failures[0])
	}
	dispatched := 0
	for _, ok := range results {
		if ok {
			dispatched++
		}
	}
	return ExecutionDispatch{Dispatched: dispatched}
}

// Drive dispatches newly ready work as completions land.
func (e *Execution) Drive() ExecutionDispatch {
	e.mu.Lock()
	e.driveActive++
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.driveActive--
		e.mu.Unlock()
	}()
	dispatched := 0
	for {
		e.mu.Lock()
		stopping := e.stopping
		e.mu.Unlock()
		if stopping {
			break
		}
		dispatched += e.pumpGraphs()
		ready := e.readyNodes()
		started := 0
		for _, node := range ready {
			spec := e.nodeSpec(node)
			if e.remainingSlots(spec.Kind) <= 0 {
				continue
			}
			e.startRun(node)
			started++
		}
		dispatched += started
		e.mu.Lock()
		busy := e.running > 0 || len(e.activeGraphs) > 0
		e.mu.Unlock()
		if !busy {
			break
		}
		if started < len(ready) {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		e.waitForWork()
	}
	return ExecutionDispatch{Dispatched: dispatched}
}

// Pump dispatches every currently ready node and returns without waiting for the workers.
func (e *Execution) Pump() ExecutionDispatch {
	e.mu.Lock()
	if e.stopping || e.pumping {
		e.mu.Unlock()
		return ExecutionDispatch{Dispatched: 0}
	}
	e.pumping = true
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.pumping = false
		e.mu.Unlock()
	}()
	dispatched := e.pumpGraphs()
	for _, node := range e.readyNodes() {
		spec := e.nodeSpec(node)
		if e.remainingSlots(spec.Kind) <= 0 {
			continue
		}
		e.startRun(node)
		dispatched++
	}
	return ExecutionDispatch{Dispatched: dispatched}
}

// pumpGraphs runs every v2 graph that currently has queued work.
func (e *Execution) pumpGraphs() int {
	if e.graphs == nil {
		return 0
	}
	dispatched := 0
	var pending []ExecutionGraph
	graphDatabaseMu.Lock()
	failed := e.runGuarded(func() {
		pending = e.graphs()
	})
	graphDatabaseMu.Unlock()
	if failed != nil {
		e.reportGraphFailure("", failed)
		return 0
	}
	for _, graph := range pending {
		e.mu.Lock()
		stopping := e.stopping
		e.mu.Unlock()
		if stopping || (e.dispatchAllowed != nil && !e.dispatchAllowed()) {
			break
		}
		graphDatabaseMu.Lock()
		paused := e.store.Task(graph.TaskId).Paused != 0
		graphDatabaseMu.Unlock()
		if paused {
			continue
		}
		e.mu.Lock()
		active := e.activeGraphs[graph.TaskId]
		e.mu.Unlock()
		if active {
			continue
		}
		dispatched++
		e.mu.Lock()
		e.activeGraphs[graph.TaskId] = true
		e.mu.Unlock()
		go func(graph ExecutionGraph) {
			defer func() {
				e.mu.Lock()
				delete(e.activeGraphs, graph.TaskId)
				e.mu.Unlock()
				e.notifyWork()
			}()
			if failure := e.runGuarded(func() {
				graph.Run()
			}); failure != nil {
				e.reportGraphFailure(graph.TaskId, failure)
			}
		}(graph)
	}
	return dispatched
}

// runGuarded runs one action and reports the panic it raised, if any.
func (e *Execution) runGuarded(action func()) (failure any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = recovered
		}
	}()
	action()
	return nil
}

// reportGraphFailure makes a graph that could not run visible.
func (e *Execution) reportGraphFailure(taskId string, failure any) {
	reason := dispatchFailureText(failure)
	graphDatabaseMu.Lock()
	defer graphDatabaseMu.Unlock()
	if taskId != "" {
		if kernelRow(e.store.Db, "SELECT 1 FROM events WHERE task_id=? AND type='graph.failed' LIMIT 1", taskId) != nil {
			return
		}
	}
	func() {
		defer func() { _ = recover() }()
		e.store.Transaction(func() any {
			e.store.Event(taskId, "graph.failed", map[string]any{"reason": reason})
			return nil
		})
	}()
}

// Kick ensures a newly queued message is dispatched even if no drive loop is active.
func (e *Execution) Kick() {
	e.sweepWorkcopies()
	e.sweepState()
	e.mu.Lock()
	active := e.driveActive
	e.mu.Unlock()
	if active == 0 {
		go func() {
			defer func() { _ = recover() }()
			e.Drive()
		}()
	}
}

// sweepWorkcopies drops the work copies of a task that reached a terminal phase.
func (e *Execution) sweepWorkcopies() {
	now := NowMillis()
	e.mu.Lock()
	swept := e.sweptAt
	e.mu.Unlock()
	if now-swept < 5_000 {
		return
	}
	e.mu.Lock()
	e.sweptAt = now
	e.mu.Unlock()
	if e.git == nil {
		return
	}
	graphDatabaseMu.Lock()
	defer graphDatabaseMu.Unlock()
	func() {
		defer func() { _ = recover() }()
		e.git.SweepTerminalWorkcopies()
	}()
}

// remainingSlots is the free execution capacity of one node kind.
func (e *Execution) remainingSlots(kind string) int64 {
	slot := "program"
	if kind == "agent" {
		slot = "agent"
	}
	return int64(ExecutionLimit(slot)) - OccupiedSlots(e.store, slot)
}

// notifyWork wakes the drive loop.
func (e *Execution) notifyWork() {
	e.mu.Lock()
	close(e.changed)
	e.changed = make(chan struct{})
	e.mu.Unlock()
}

// waitForWork blocks until one unit of work settles or the drive loop is woken.
func (e *Execution) waitForWork() {
	e.mu.Lock()
	signal := e.changed
	e.mu.Unlock()
	<-signal
}
