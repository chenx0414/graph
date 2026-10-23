package graph

import (
	"encoding/json"
	"time"
)

// NewExecution builds the executor over one task store.
func NewExecution(store *TaskStore, actions map[string]ActionAdapter, extras ExecutionExtras) *Execution {
	execution := &Execution{
		store:           store,
		actions:         actions,
		catalog:         extras.Catalog,
		models:          extras.Models,
		preferences:     extras.Preferences,
		preferencesFunc: extras.PreferencesFunc,
		git:             extras.Git,
		systemContext:   extras.SystemContext,
		access:          extras.Access,
		dispatchAllowed: extras.DispatchAllowed,
		graphs:          extras.Graphs,
		autoWake:        extras.AutoWake,
		activeGraphs:    map[string]bool{},
		changed:         make(chan struct{}),
	}
	if extras.Fallback != nil {
		execution.fallback = extras.Fallback
	}
	execution.unsubscribe = store.OnEvent(func(eventType string) {
		if execution.autoWake && eventType == "problem.routed" {
			// The TypeScript runtime queued a microtask here; Go hands it to its
			// own goroutine so the event is delivered after the current statement.
			go execution.Kick()
		}
	})
	execution.lifecycle = NewOperationLifecycle(store, OperationLifecycleHooks{
		CanReplayBeforeSend: func(operation Operation) bool {
			adapter := execution.adapterFor(operation.Action)
			if adapter == nil || adapter.CanReplayBeforeSend == nil {
				return false
			}
			return adapter.CanReplayBeforeSend(operation)
		},
	})
	execution.generation = execution.lifecycle.Recover()
	row := kernelRow(store.Db, "SELECT active_task FROM runtime")
	activeTask := kernelString(row["active_task"])
	if activeTask != "" && execution.git != nil {
		execution.git.Restore(activeTask)
	}
	return execution
}

// adapterFor resolves the adapter of one action exactly like dispatch does.
func (e *Execution) adapterFor(action string) *ActionAdapter {
	if adapter, ok := e.actions[action]; ok {
		return &adapter
	}
	return e.fallback
}

// Drain stops the executor. Shutdown is bounded: a provider stream can hang
// indefinitely, so the daemon must not wait past its stop deadline.
func (e *Execution) Drain() {
	e.mu.Lock()
	e.stopping = true
	e.mu.Unlock()
	if e.unsubscribe != nil {
		e.unsubscribe()
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		e.mu.Lock()
		busy := e.running > 0 || len(e.activeGraphs) > 0
		e.mu.Unlock()
		if !busy || time.Now().After(deadline) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// SettleGraphShutdown finishes all kernel writers before closing SQLite.
func (e *Execution) SettleGraphShutdown() {
	for {
		e.mu.Lock()
		busy := len(e.activeGraphs) > 0
		e.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ReserveTokensFor is the token reservation one dispatch of this action needs.
func (e *Execution) ReserveTokensFor(action string) *int {
	if action == "" {
		return nil
	}
	adapter := e.adapterFor(action)
	if adapter == nil {
		return nil
	}
	return adapter.ReserveTokens
}

// Report settles one operation with the result a worker produced.
func (e *Execution) Report(id string, generation int, result OperationResult) {
	graphDatabaseMu.Lock()
	e.lifecycle.Report(id, generation, result)
	graphDatabaseMu.Unlock()
	if e.autoWake {
		e.Kick()
	}
}

// Reconcile resolves an unknown external outcome.
func (e *Execution) Reconcile(id string) {
	graphDatabaseMu.Lock()
	initial := e.lifecycle.Get(id)
	if initial == nil {
		graphDatabaseMu.Unlock()
		Raise("not_found", "Operation not found")
	}
	if initial.State != "unknown" {
		graphDatabaseMu.Unlock()
		return
	}
	adapter := e.adapterFor(initial.Operation.Action)
	if adapter == nil || adapter.Reconcile == nil {
		graphDatabaseMu.Unlock()
		Raise("reconciliation_unavailable", "No external reconciliation adapter is registered")
	}
	graphDatabaseMu.Unlock()
	e.lifecycle.Reconcile(id, func(operation Operation) Reconciliation {
		return adapter.Reconcile(operation)
	}, nil)
}

// StopActiveMasterTurns soft-stops the live master turn of a task.
func (e *Execution) StopActiveMasterTurns(taskId string) int {
	graphDatabaseMu.Lock()
	rows := kernelRows(e.store.Db, `SELECT o.id,o.spec FROM operations o
      JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
      WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
        AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid`, taskId)
	graphDatabaseMu.Unlock()
	stopped := 0
	for _, row := range rows {
		var operation Operation
		if err := json.Unmarshal([]byte(kernelString(row["spec"])), &operation); err != nil {
			panic(err)
		}
		adapter := e.adapterFor(operation.Action)
		if adapter == nil || adapter.Stop == nil {
			continue
		}
		func() {
			defer func() { _ = recover() }()
			adapter.Stop(operation)
			stopped++
		}()
	}
	return stopped
}

// Steer hands a running turn an operator message.
func (e *Execution) Steer(operationId, text string) *int64 {
	return e.lifecycle.Steer(operationId, func(operation Operation) *int64 {
		adapter := e.adapterFor(operation.Action)
		if adapter == nil || adapter.Steer == nil {
			Raise("steering_unavailable", "The active Agent does not support steering messages")
		}
		return steerOrdinal(adapter.Steer(operation, text))
	})
}

// Interrupt stops a running turn.
func (e *Execution) Interrupt(operationId string, text *string) *int64 {
	return e.lifecycle.Interrupt(operationId, func(operation Operation) *int64 {
		adapter := e.adapterFor(operation.Action)
		if adapter == nil {
			Raise("interrupt_unavailable", "The active Agent does not support interruption")
		}
		if adapter.Interrupt != nil {
			return steerOrdinal(adapter.Interrupt(operation, text))
		}
		if adapter.Steer != nil && text != nil {
			return steerOrdinal(adapter.Steer(operation, *text))
		}
		Raise("interrupt_unavailable", "The active Agent does not support interruption")
		return nil
	})
}

// steerOrdinal reads the ordinal an adapter returned, when it returned one.
func steerOrdinal(result any) *int64 {
	record, ok := jsonRecord(result)
	if !ok {
		return nil
	}
	value, ok := record["ordinal"]
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case float64:
		total := int64(typed)
		return &total
	case int64:
		total := typed
		return &total
	case int:
		total := int64(typed)
		return &total
	}
	return nil
}

// Answer resolves a human answer. It is called only inside the authenticated command transaction.
func (e *Execution) Answer(taskId, questionId string, answer Answer) {
	graphDatabaseMu.Lock()
	defer graphDatabaseMu.Unlock()
	e.lifecycle.Answer(taskId, questionId, answer, e.models)
}

// Escalate hands a main-owned problem to the user with an explanation.
func (e *Execution) Escalate(taskId, questionId, prompt string) {
	graphDatabaseMu.Lock()
	e.lifecycle.Escalate(taskId, questionId, prompt)
	graphDatabaseMu.Unlock()
	if e.autoWake {
		e.Kick()
	}
}

// Abandon stops a task for good, releasing the active slot to the queue.
func (e *Execution) Abandon(taskId string, reason *string, allowMasterTurn bool) int64 {
	graphDatabaseMu.Lock()
	defer graphDatabaseMu.Unlock()
	task := e.store.Task(taskId)
	switch task.Phase {
	case "completed", "abandoned", "stopped", "stopping":
		Raise("invalid_input", "A "+task.Phase+" task cannot be abandoned")
	}
	kernel := NewKernelStore(e.store)
	if kernel.LatestRevision(taskId) != nil {
		NewGraphRuntime(kernel, taskId, nil).Stop()
		return e.store.Event(taskId, "task.stop_requested", map[string]any{"reason": reasonValue(reason)})
	}
	var busy bool
	if allowMasterTurn {
		busy = kernelRow(e.store.Db, `SELECT o.id FROM operations o
          JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
          WHERE o.task_id=? AND o.worker_active=1 AND json_extract(n.spec,'$.role') IS NOT 'master'`, taskId) != nil
	} else {
		busy = kernelRow(e.store.Db, "SELECT id FROM operations WHERE task_id=? AND worker_active=1", taskId) != nil
	}
	if busy {
		Raise("task_busy", "Pause the task and wait for its running work to settle before abandoning it")
	}
	resolved := e.store.ResolveTaskQuestions(taskId, map[string]any{"type": "abandoned", "reason": reasonValue(reason)})
	e.store.AbandonTask(taskId)
	cursor := e.store.Event(taskId, "task.abandoned", map[string]any{"reason": reasonValue(reason), "resolvedQuestions": resolved})
	ReleaseTaskSlot(e.store, taskId)
	return cursor
}

func reasonValue(reason *string) any {
	if reason == nil {
		return nil
	}
	return *reason
}

// block parks a node behind a question.
func (e *Execution) block(node ExecutionNodeRow, kind string, data Json, operationId *string) {
	e.lifecycle.Block(node.TaskId, node.Id, kind, data, operationId)
}
