package graph

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// graphDatabaseMu serializes the synchronous SQLite sections of the runtime.
// The TypeScript backend was single threaded: every database statement ran to
// completion between awaits. Go runs the adapter's real I/O in goroutines, so
// the statements that surround it are guarded here instead of interleaving
// inside another goroutine's transaction.
var graphDatabaseMu sync.Mutex

// ExecutionNodeRow is one node the executor can dispatch.
type ExecutionNodeRow struct {
	Id           string
	TaskId       string
	Spec         string
	InstanceId   *string
	Status       string
	Output       *string
	ActivationId string
}

// ExecutionGraph is one v2 graph the executor can drain.
type ExecutionGraph struct {
	TaskId string
	// Run drives the graph once. It reports whether the graph drained.
	Run func() bool
}

// ExecutionSystemContext is the host inventory the main Agent may read.
type ExecutionSystemContext struct {
	Resources         bool
	AgentCombinations bool
	SystemSummary     bool
}

// ExecutionExtras are the optional collaborators of the executor.
type ExecutionExtras struct {
	Fallback        *ActionAdapter
	Catalog         *Catalog
	Models          func() []ModelEntry
	Preferences     map[ModelGrade][]string
	PreferencesFunc func() map[ModelGrade][]string
	Git             *GitIntegration
	AutoWake        bool
	DispatchAllowed func() bool
	Graphs          func() []ExecutionGraph
	SystemContext   *ExecutionSystemContext
	Access          func() *ResolvedAccessPolicy
	Artifacts       *ArtifactWorkspace
}

// ExecutionDispatch counts the work one dispatch round started.
type ExecutionDispatch struct {
	Dispatched int `json:"dispatched"`
}

// Execution is the main execution state machine; graph agents run through the native lane.
type Execution struct {
	mu              sync.Mutex
	store           *TaskStore
	actions         map[string]ActionAdapter
	fallback        *ActionAdapter
	catalog         *Catalog
	models          func() []ModelEntry
	preferences     map[ModelGrade][]string
	preferencesFunc func() map[ModelGrade][]string
	git             *GitIntegration
	systemContext   *ExecutionSystemContext
	access          func() *ResolvedAccessPolicy
	dispatchAllowed func() bool
	graphs          func() []ExecutionGraph
	autoWake        bool
	generation      int
	lifecycle       *OperationLifecycle
	unsubscribe     func()
	pumping         bool
	stopping        bool
	driveActive     int
	sweptAt         int64
	activeGraphs    map[string]bool
	running         int
	changed         chan struct{}
}

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

// startRun runs one node in its own goroutine.
func (e *Execution) startRun(node ExecutionNodeRow) {
	go func() {
		_, _ = e.run(node)
	}()
}

// run dispatches one node and reports whether it was dispatched.
func (e *Execution) run(node ExecutionNodeRow) (bool, any) {
	e.mu.Lock()
	e.running++
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.running--
		e.mu.Unlock()
		e.notifyWork()
	}()
	return e.runGuardedBool(func() bool {
		return e.execute(node)
	})
}

func (e *Execution) runGuardedBool(action func() bool) (result bool, failure any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = recovered
			result = false
		}
	}()
	return action(), nil
}

// laneTasks lists the conversation masters and the single active task.
// The caller holds the database lock.
func (e *Execution) laneTasks() []string {
	rows := kernelRows(e.store.Db, `SELECT t.id FROM tasks t
      LEFT JOIN conversations c ON c.id=t.conversation_id
      WHERE t.phase='chatting' AND c.archived_at IS NULL
      ORDER BY t.created_seq`)
	chatting := []string{}
	for _, row := range rows {
		chatting = append(chatting, kernelString(row["id"]))
	}
	active := kernelString(kernelRow(e.store.Db, "SELECT active_task FROM runtime")["active_task"])
	if active != "" && !containsString(chatting, active) && e.store.Task(active).Phase != "chatting" {
		chatting = append(chatting, active)
	}
	return chatting
}

// nodeSpec parses one node spec.
func (e *Execution) nodeSpec(node ExecutionNodeRow) NodeSpec {
	var spec NodeSpec
	if err := json.Unmarshal([]byte(node.Spec), &spec); err != nil {
		panic(err)
	}
	return spec
}

// refreshDefinition follows the latest version of the node's own recipe.
// The caller holds the database lock.
func (e *Execution) refreshDefinition(node ExecutionNodeRow) ExecutionNodeRow {
	spec := e.nodeSpec(node)
	id := ""
	if spec.DefinitionVersion != nil {
		id = strings.Split(*spec.DefinitionVersion, "@")[0]
	}
	definitionVersion := ""
	if id != "" && e.catalog != nil {
		definitions := e.catalog.ListDefinitions()
		found := false
		var version int64
		for _, item := range definitions {
			if item.Id != id {
				continue
			}
			if !found || item.Version > version {
				found = true
				version = item.Version
			}
		}
		if found {
			definitionVersion = id + "@" + itoa(int(version))
		}
	}
	if definitionVersion == "" {
		return node
	}
	if spec.DefinitionVersion != nil && definitionVersion == *spec.DefinitionVersion {
		return node
	}
	spec.DefinitionVersion = &definitionVersion
	specText := CanonicalJSON(spec)
	kernelExec(e.store.Db, "UPDATE nodes SET spec=? WHERE task_id=? AND id=?", specText, node.TaskId, node.Id)
	if node.InstanceId != nil {
		kernelExec(e.store.Db, "UPDATE instances SET definition_version=? WHERE id=?", definitionVersion, *node.InstanceId)
	}
	node.Spec = specText
	return node
}

// readyNodes lists every node that may be dispatched now.
func (e *Execution) readyNodes() []ExecutionNodeRow {
	if e.stopping || (e.dispatchAllowed != nil && !e.dispatchAllowed()) {
		return nil
	}
	graphDatabaseMu.Lock()
	defer graphDatabaseMu.Unlock()
	nodes := []ExecutionNodeRow{}
	for _, taskId := range e.laneTasks() {
		if e.store.Task(taskId).Paused != 0 {
			continue
		}
		nodes = append(nodes, e.readyNodesFor(taskId)...)
	}
	return nodes
}

// readyNodesFor lists the ready nodes of one task. The caller holds the database lock.
func (e *Execution) readyNodesFor(taskId string) []ExecutionNodeRow {
	task := e.store.Task(taskId)
	if task.Phase == "chatting" {
		conversation := ConversationForTask(e.store, taskId)
		if conversation == nil || conversation.ArchivedAt != nil {
			return nil
		}
		// A conversation that has no message yet is still being created: the
		// TypeScript host appended the first message in the same synchronous block
		// that created the master node, so the node could never be dispatched
		// before the message it has to answer existed. The Go host runs the
		// creation and the dispatch on separate goroutines, so a master whose
		// conversation still has no message waits for one.
		if kernelInt(kernelRow(e.store.Db, "SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", conversation.Id)["count"]) == 0 {
			return nil
		}
		rows := kernelRows(e.store.Db, `SELECT * FROM nodes n
        WHERE n.task_id=? AND n.status='pending' AND json_extract(n.spec,'$.role')='master'
        ORDER BY n.rowid`, taskId)
		out := []ExecutionNodeRow{}
		for _, row := range rows {
			node := executionNodeRowOf(row)
			if IsMasterParked(e.store, taskId, node.Id) {
				continue
			}
			if task.Paused != 0 && PendingRsiContinuation(e.store, taskId, node.Id) != nil {
				continue
			}
			out = append(out, node)
		}
		return out
	}
	if task.Phase != "discussing" {
		return nil
	}
	rows := kernelRows(e.store.Db, "SELECT * FROM nodes WHERE task_id=? AND status='pending' AND json_extract(spec,'$.role')='master' ORDER BY rowid", taskId)
	out := []ExecutionNodeRow{}
	for _, row := range rows {
		out = append(out, executionNodeRowOf(row))
	}
	return out
}

func executionNodeRowOf(row map[string]any) ExecutionNodeRow {
	node := ExecutionNodeRow{
		Id:           kernelString(row["id"]),
		TaskId:       kernelString(row["task_id"]),
		Spec:         kernelString(row["spec"]),
		Status:       kernelString(row["status"]),
		ActivationId: kernelString(row["activation_id"]),
	}
	if row["instance_id"] != nil {
		value := kernelString(row["instance_id"])
		node.InstanceId = &value
	}
	if row["output"] != nil {
		value := kernelString(row["output"])
		node.Output = &value
	}
	return node
}

// execute dispatches one node: admit, prepare, dispatch, settle.
func (e *Execution) execute(node ExecutionNodeRow) bool {
	graphDatabaseMu.Lock()
	accessPolicy := e.currentAccessPolicy()
	fullAccess := IsFullAccess(accessPolicy)
	if e.stopping || (e.dispatchAllowed != nil && !e.dispatchAllowed()) || e.store.Task(node.TaskId).Paused != 0 {
		graphDatabaseMu.Unlock()
		return false
	}
	status := kernelRow(e.store.Db, "SELECT status FROM nodes WHERE task_id=? AND id=?", node.TaskId, node.Id)
	if status == nil || kernelString(status["status"]) != "pending" {
		graphDatabaseMu.Unlock()
		return false
	}
	if e.store.Task(node.TaskId).Phase == "chatting" {
		conversation := ConversationForTask(e.store, node.TaskId)
		if conversation == nil || conversation.ArchivedAt != nil {
			graphDatabaseMu.Unlock()
			return false
		}
	}
	node = e.refreshDefinition(node)
	spec := e.nodeSpec(node)
	if spec.Role == nil || *spec.Role != "master" || spec.Kind != "agent" {
		graphDatabaseMu.Unlock()
		Raise("invalid_node", "External main executor only accepts the main agent")
	}
	adapter := e.adapterFor(spec.Action)
	if adapter == nil || adapter.Kind != spec.Kind {
		e.store.Transaction(func() any {
			e.block(node, "adapter_error", map[string]any{"reason": "No " + spec.Kind + " adapter for " + spec.Action}, nil)
			return nil
		})
		graphDatabaseMu.Unlock()
		return false
	}
	if spec.Kind == "agent" && e.models != nil && node.InstanceId != nil {
		preferences := e.preferences
		if e.preferencesFunc != nil {
			preferences = e.preferencesFunc()
		}
		selected := PickModel(PickModelInput{
			Spec:        spec,
			Models:      e.models,
			Catalog:     e.catalog,
			Preferences: preferences,
		})
		if selected == nil {
			e.store.Transaction(func() any {
				e.block(node, "model_unavailable", map[string]any{"requested": spec.Model}, nil)
				return nil
			})
			graphDatabaseMu.Unlock()
			return false
		}
		var definitionVersion any
		if spec.DefinitionVersion != nil {
			definitionVersion = *spec.DefinitionVersion
		}
		kernelExec(e.store.Db, "UPDATE instances SET model=?,definition_version=? WHERE id=?", selected.Id, definitionVersion, *node.InstanceId)
		identity := selected.Id
		if selected.ModelId != "" {
			identity = selected.ModelId
		}
		RecordModelUse(e.store, *node.InstanceId, identity)
		if spec.Model != nil && *spec.Model != selected.Id {
			e.store.Event(node.TaskId, "model.switched", map[string]any{
				"nodeId":     node.Id,
				"from":       *spec.Model,
				"to":         selected.Id,
				"instanceId": *node.InstanceId,
			})
		}
	}
	baseGrants := []string{}
	projectRow := kernelRow(e.store.Db, "SELECT grants FROM projects WHERE id=?", e.store.Task(node.TaskId).ProjectID)
	if projectRow != nil {
		var stored []string
		if err := json.Unmarshal([]byte(kernelString(projectRow["grants"])), &stored); err != nil {
			panic(err)
		}
		baseGrants = stored
	}
	grants := append([]string{}, baseGrants...)
	for _, row := range kernelRows(e.store.Db, "SELECT grant FROM task_grants WHERE task_id=?", node.TaskId) {
		grant := kernelString(row["grant"])
		if !containsString(grants, grant) {
			grants = append(grants, grant)
		}
	}
	requiredGrant := adapter.Grant
	if requiredGrant != nil && *requiredGrant != "" && !containsString(grants, *requiredGrant) {
		if accessPolicy != nil && accessPolicy.AutoApprove.Permission {
			e.store.Transaction(func() any {
				InsertQuestion(e.store, QuestionInput{
					TaskId:     node.TaskId,
					NodeId:     node.Id,
					Kind:       "permission",
					Data:       map[string]any{"grant": *requiredGrant},
					AutoAnswer: &QuestionAutoAnswer{Answer: Answer{Type: "grant", Grant: *requiredGrant}, PolicyDigest: accessPolicy.Digest},
				})
				return nil
			})
			grants = append(grants, *requiredGrant)
		} else {
			e.store.Transaction(func() any {
				e.block(node, "permission", map[string]any{"grant": *requiredGrant}, nil)
				return nil
			})
			graphDatabaseMu.Unlock()
			return false
		}
	}
	slot := "program"
	if spec.Kind == "agent" {
		slot = "agent"
	}
	if OccupiedSlots(e.store, slot) >= int64(ExecutionLimit(slot)) {
		graphDatabaseMu.Unlock()
		return false
	}
	reservation := int64(0)
	if spec.Kind == "agent" {
		if adapter.ReserveTokens == nil {
			graphDatabaseMu.Unlock()
			Raise("invalid_adapter", "A bounded token reservation is required")
		}
		reservation = int64(*adapter.ReserveTokens)
	}
	if reservation < 0 {
		graphDatabaseMu.Unlock()
		Raise("invalid_adapter", "A bounded token reservation is required")
	}
	if node.InstanceId != nil && !fullAccess {
		failure := func() (failure any) {
			defer func() {
				if recovered := recover(); recovered != nil {
					failure = recovered
				}
			}()
			AssertWithinBudget(e.store, *node.InstanceId, reservation)
			return nil
		}()
		if failure != nil {
			refusal, ok := failure.(*RuntimeError)
			if !ok || refusal.Code != "budget" {
				graphDatabaseMu.Unlock()
				panic(failure)
			}
			e.store.Transaction(func() any {
				e.block(node, "budget", map[string]any{"reason": refusal.Message, "requested": reservation}, nil)
				return nil
			})
			graphDatabaseMu.Unlock()
			return false
		}
	}
	var workspace *string
	if e.git != nil {
		workspace = e.git.Workspace(node.TaskId, node.InstanceId, node.Id, spec.Kind, spec.Action)
	}
	operation, admitted := e.admit(node, spec, reservation, workspace, accessPolicy, grants)
	if !admitted {
		graphDatabaseMu.Unlock()
		return false
	}
	graphDatabaseMu.Unlock()

	// The adapter prepares and dispatches outside the store lock: both are real I/O.
	dispatch, prepareFailure := e.prepareDispatch(adapter, operation)
	if prepareFailure != "" {
		graphDatabaseMu.Lock()
		e.lifecycle.MarkPreparationFailed(operation.Id, prepareFailure)
		graphDatabaseMu.Unlock()
		return false
	}

	graphDatabaseMu.Lock()
	deferredContinuation := operation.Context.RsiContinuation != nil && (e.store.Task(node.TaskId).Paused != 0 ||
		conversationArchived(e.store, node.TaskId))
	if e.stopping || deferredContinuation || (e.dispatchAllowed != nil && !e.dispatchAllowed()) || e.store.Task(node.TaskId).Paused != 0 {
		e.lifecycle.CancelBeforeDispatch(operation.Id, "Cancelled before dispatch")
		graphDatabaseMu.Unlock()
		return false
	}
	e.lifecycle.Dispatch(operation)
	graphDatabaseMu.Unlock()

	result, dispatchFailure := e.runDispatch(dispatch)
	graphDatabaseMu.Lock()
	if dispatchFailure == nil {
		reportFailure := e.reportResult(operation, result)
		graphDatabaseMu.Unlock()
		if reportFailure != nil {
			panic(reportFailure)
		}
		if e.autoWake {
			e.Kick()
		}
		return true
	}
	refusal, isRefusal := dispatchFailure.(*RuntimeError)
	if isRefusal && e.lifecycle.HandleDispatchRefusal(operation, refusal, reservation) {
		graphDatabaseMu.Unlock()
		return false
	}
	e.lifecycle.MarkUncertain(operation, dispatchFailureText(dispatchFailure), false)
	graphDatabaseMu.Unlock()
	return true
}

// currentAccessPolicy is the policy frozen for this execution.
func (e *Execution) currentAccessPolicy() *ResolvedAccessPolicy {
	if e.access != nil {
		return e.access()
	}
	policy := StandardAccessPolicy()
	return ResolveAccessPolicy(policy, AccessPolicyContext{})
}

// conversationArchived reports whether the conversation of a task is archived.
func conversationArchived(store *TaskStore, taskId string) bool {
	conversation := ConversationForTask(store, taskId)
	return conversation != nil && conversation.ArchivedAt != nil
}

// prepareDispatch asks the adapter for its dispatch callback.
func (e *Execution) prepareDispatch(adapter *ActionAdapter, operation Operation) (func() OperationResult, string) {
	if adapter.Prepare == nil {
		return nil, "prepare must return a dispatch callback"
	}
	var dispatch func() OperationResult
	failure := func() (failure any) {
		defer func() {
			if recovered := recover(); recovered != nil {
				failure = recovered
			}
		}()
		dispatch = adapter.Prepare(operation)
		return nil
	}()
	if failure != nil {
		return nil, dispatchFailureText(failure)
	}
	if dispatch == nil {
		return nil, "prepare must return a dispatch callback"
	}
	return dispatch, ""
}

// runDispatch runs the adapter's dispatch callback.
func (e *Execution) runDispatch(dispatch func() OperationResult) (result OperationResult, failure any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = recovered
		}
	}()
	return dispatch(), nil
}

// dispatchFailureText renders the error a dispatch raised.
func dispatchFailureText(failure any) string {
	switch typed := failure.(type) {
	case error:
		return typed.Error()
	case string:
		return typed
	default:
		return jsonStringify(failure)
	}
}

// reportResult settles the operation with the result the worker produced.
// The caller holds the database lock.
func (e *Execution) reportResult(operation Operation, result OperationResult) (failure any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = recovered
		}
	}()
	e.lifecycle.Report(operation.Id, operation.Generation, result)
	return nil
}

// admit creates the durable intent of one execution.
func (e *Execution) admit(node ExecutionNodeRow, spec NodeSpec, reservation int64, workspace *string,
	accessPolicy *ResolvedAccessPolicy, grants []string) (Operation, bool) {
	var handoffPackage *ContextHandoffPackage
	operation, admitted, failure := func() (operation Operation, admitted bool, failure any) {
		defer func() {
			if recovered := recover(); recovered != nil {
				failure = recovered
			}
		}()
		task := e.store.Task(node.TaskId)
		conversation := ConversationForTask(e.store, node.TaskId)
		chatMessages := []MessageRow{}
		if task.Phase == "chatting" && conversation != nil {
			chatMessages = PendingMessages(e.store, conversation.Id, 1)
		}
		var rsiContinuation *RsiContinuation
		var pauseContinuation *PauseContinuation
		var wakes []PendingWake
		if conversation != nil {
			rsiContinuation = PendingRsiContinuation(e.store, node.TaskId, node.Id)
			pauseContinuation = PendingPauseContinuation(e.store, node.TaskId, node.Id)
			wakes = PendingWakes(e.store, node.TaskId, node.Id)
		}
		answers := []OperationAnswer{}
		for _, row := range kernelRows(e.store.Db, "SELECT id,answer FROM questions WHERE task_id=? AND node_id=? AND kind IN ('waiting','system_change') AND status='resolved' ORDER BY rowid", node.TaskId, node.Id) {
			var payload map[string]any
			if err := json.Unmarshal([]byte(kernelString(row["answer"])), &payload); err != nil {
				panic(err)
			}
			answers = append(answers, OperationAnswer{QuestionId: kernelString(row["id"]), Value: payload["value"]})
		}
		messages := []OperationMessage{}
		if task.Phase == "chatting" {
			for _, message := range chatMessages {
				id := message.Id
				entry := OperationMessage{
					Id:                 &id,
					Text:               message.Text,
					RequirementVersion: int(task.RequirementVersion),
				}
				if message.Data != nil {
					var data map[string]any
					if err := json.Unmarshal([]byte(*message.Data), &data); err == nil {
						if attachments, ok := data["attachments"].([]any); ok {
							for _, raw := range attachments {
								record, ok := jsonRecord(raw)
								if !ok {
									continue
								}
								entry.Attachments = append(entry.Attachments, AttachmentInput{
									Name: stringField(record, "name"),
									Type: stringField(record, "type"),
									Size: int64(numberField(record, "size")),
									Text: stringField(record, "text"),
									Data: optionalStringField(record, "data"),
								})
							}
						}
						if command, ok := data["command"].(string); ok && command != "" {
							entry.Command = &command
						}
					}
				}
				messages = append(messages, entry)
			}
		} else {
			for _, row := range kernelRows(e.store.Db, "SELECT data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor", node.TaskId) {
				var payload map[string]any
				if err := json.Unmarshal([]byte(kernelString(row["data"])), &payload); err != nil {
					panic(err)
				}
				text := stringField(payload, "text")
				if text == "" {
					text = stringField(payload, "request")
				}
				version := 1
				if value, ok := payload["requirementVersion"].(float64); ok {
					version = int(value)
				}
				messages = append(messages, OperationMessage{Text: text, RequirementVersion: version})
			}
		}
		latest := kernelRow(e.store.Db, "SELECT spec FROM proposals WHERE task_id=? AND version=?", node.TaskId, task.LatestProposal)
		var proposal *NativeProposal
		if latest != nil {
			var parsed NativeProposal
			if err := json.Unmarshal([]byte(kernelString(latest["spec"])), &parsed); err != nil {
				panic(err)
			}
			proposal = &parsed
		}
		var agentContext *ResolvedAgentContext
		if spec.Kind == "agent" {
			resolved := ResolveAgentContext(e.store, ResolveAgentContextInput{
				TaskId: node.TaskId,
				NodeId: node.Id,
				Spec:   spec,
			})
			agentContext = &resolved
		}
		operationWakes := []OperationWake{}
		for _, wake := range wakes {
			operationWakes = append(operationWakes, OperationWake{
				Kind:      string(wake.Kind),
				DedupeKey: wake.DedupeKey,
				TaskId:    wake.TaskID,
				Data:      wake.Data,
			})
		}
		var previousOutput Json
		if node.Output != nil {
			previousOutput = parseJSON(*node.Output)
		}
		proposalVersion := 0
		if task.AcceptedProposal != nil {
			proposalVersion = int(*task.AcceptedProposal)
		}
		intent := OperationIntent{
			TaskId:             node.TaskId,
			NodeId:             node.Id,
			InstanceId:         node.InstanceId,
			Kind:               spec.Kind,
			Action:             spec.Action,
			Input:              spec.Input,
			Dependencies:       map[string]Json{},
			ProposalVersion:    proposalVersion,
			RequirementVersion: int(task.RequirementVersion),
			Context: OperationContext{
				PreviousOutput:  previousOutput,
				RsiContinuation: rsiContinuation,
				Wakes:           operationWakes,
				Answers:         answers,
				Messages:        messages,
			},
			Grants:            grants,
			AccessPolicy:      accessPolicy,
			ActivationId:      node.ActivationId,
			GraphVersion:      int(task.GraphVersion),
			DependencySources: map[string][]DependencySource{},
			InputVersions:     map[string][]InputVersion{},
			Workspace:         workspace,
		}
		var conversationStatus *string
		if conversation != nil {
			status := ConversationDigest(e.store, conversation.Id)
			conversationStatus = &status
		}
		extra := BriefingExtra{
			Request:      task.Request,
			Acceptance:   []AcceptanceItem{},
			Conversation: conversationStatus,
		}
		if proposal != nil {
			summary := proposal.Summary
			extra.Summary = &summary
			extra.Acceptance = proposal.Acceptance
		}
		if task.DecisionDigest != nil {
			decisions := *task.DecisionDigest
			extra.Decisions = &decisions
		}
		if e.catalog != nil {
			var capabilities []BriefingCapability
			if spec.DefinitionVersion != nil && *spec.DefinitionVersion != "" {
				definition, definitionFailure := func() (definition CatalogDefinition, failure any) {
					defer func() {
						if recovered := recover(); recovered != nil {
							failure = recovered
						}
					}()
					return e.catalog.Definition(*spec.DefinitionVersion), nil
				}()
				if definitionFailure == nil {
					for _, binding := range definition.Capabilities {
						capabilities = append(capabilities, BriefingCapability{Id: binding.Id, Version: binding.Version})
					}
				}
			}
			if len(capabilities) > 0 {
				extra.Capabilities = capabilities
			}
			if spec.Role != nil && *spec.Role == "master" {
				definitions := []string{}
				for _, item := range e.catalog.AvailableAgentDefinitions() {
					definitions = append(definitions, item.Id+"@"+itoa(int(item.Version)))
				}
				combinations := []BriefingAgentCombination{}
				for _, item := range e.catalog.AgentCombinations() {
					combinations = append(combinations, BriefingAgentCombination{
						Id:               item.Id,
						Name:             item.Name,
						Description:      item.Description,
						RecommendedGrade: string(item.RecommendedGrade),
						Status:           item.Status,
					})
				}
				extra.Catalog = &BriefingCatalog{Definitions: definitions, AgentCombinations: combinations}
				if e.systemContext != nil {
					extra.SystemContext = &BriefingSystemContext{
						Resources:         e.systemContext.Resources,
						AgentCombinations: e.systemContext.AgentCombinations,
						SystemSummary:     e.systemContext.SystemSummary,
					}
				}
			}
		} else if spec.Role != nil && *spec.Role == "master" && e.systemContext != nil {
			extra.SystemContext = &BriefingSystemContext{
				Resources:         e.systemContext.Resources,
				AgentCombinations: e.systemContext.AgentCombinations,
				SystemSummary:     e.systemContext.SystemSummary,
			}
		}
		provisional := intent.operation("", 0, 0)
		briefing := Briefing(provisional, extra)
		outputSchema := SchemaRef{Kind: "agent_result", Version: 1}
		intent.Context.OutputSchema = &outputSchema
		userRework := kernelRows(e.store.Db, "SELECT text,data FROM node_entries WHERE task_id=? AND node_id=? AND json_extract(data,'$.reworkActivation')=? ORDER BY seq", node.TaskId, node.Id, node.ActivationId)
		parts := []string{}
		for _, message := range userRework {
			from := ""
			if message["data"] != nil {
				var data map[string]any
				if err := json.Unmarshal([]byte(kernelString(message["data"])), &data); err == nil {
					from = stringField(data, "from")
				}
			}
			if from != "" {
				parts = append(parts, "Peer Agent "+from+" messaged you; treat this as an instruction for this turn and address it in your existing session:\n"+kernelString(message["text"]))
			} else {
				parts = append(parts, "User requested rework of this node and its downstream results. Continue in your existing session and address this message:\n"+kernelString(message["text"]))
			}
		}
		parts = append(parts, briefing)
		if conversation != nil && IsSummaryLeakRetry(intent.Context.PreviousOutput) {
			parts = append(parts, "上一轮输出了内部会话摘要，没有回答用户。请沿用现有会话，完成上一轮用户的原始请求，只给用户正式答复；不要输出 <analysis>、<summary> 或交接摘要。已完成的调查和工具调用无需重复。")
		}
		if len(wakes) > 0 {
			parts = append(parts, RenderWakes(wakes))
		}
		if rsiContinuation != nil {
			parts = append(parts, "RSI reload confirmed for "+rsiContinuation.Commit+" (request "+rsiContinuation.RequestId+"). Resume the unfinished user request from operation "+rsiContinuation.OperationId+" using the existing session. Completed changes and tool results remain valid. Follow any newer user message first; if the goal is already complete, report completion and stop. This is a host continuation, not a new user request.")
		}
		if pauseContinuation != nil {
			parts = append(parts, "The user paused this task and has now resumed it (request "+pauseContinuation.RequestId+"). Continue the exact turn that was soft-stopped at operation "+pauseContinuation.OperationId+" using the existing session: the in-flight tool call finished, so do not repeat completed tool calls or restart the request. Follow any newer user message first; if the goal is already complete, report completion and stop. This is a host continuation, not a new user request.")
		}
		kept := []string{}
		for _, part := range parts {
			if part != "" {
				kept = append(kept, part)
			}
		}
		joined := strings.Join(kept, "\n\n")
		intent.Context.Briefing = &joined
		if agentContext != nil {
			handoff := ContextHandoffPackage{
				Mode:             agentContext.Mode,
				Purpose:          agentContext.Purpose,
				Independence:     agentContext.Independence,
				RequestedFacts:   agentContext.RequestedFacts,
				ReasonCode:       agentContext.ReasonCode,
				SourceNodeId:     nil,
				SourceInstanceId: nil,
				SourceSessionId:  nil,
				SourceLeafId:     agentContext.SourceLeafId,
				Summary:          task.Request,
				Decisions:        []string{},
				Acceptance:       []AcceptanceItem{},
				ArtifactRefs:     []ArtifactReference{},
				OutputSchema:     outputSchema,
				Briefing:         joined,
			}
			if proposal != nil {
				handoff.Summary = proposal.Summary
				handoff.Decisions = proposal.Decisions
				handoff.Acceptance = proposal.Acceptance
			}
			if task.DecisionDigest != nil {
				handoff.Decisions = []string{*task.DecisionDigest}
			}
			handoffPackage = &handoff
			handoffDigest := contextDigest(handoff)
			constraintsDigest := HandoffConstraintsDigest(handoff)
			updated := *agentContext
			updated.HandoffDigest = handoffDigest
			updated.ConstraintsDigest = constraintsDigest
			intent.Context.AgentContext = &updated
		}
		operation = e.lifecycle.Admit(OperationAdmitInput{
			Node:        OperationNode{Id: node.Id, TaskId: node.TaskId, ActivationId: node.ActivationId},
			Reservation: reservation,
			Prepare: func(attempt int) OperationIntent {
				return intent
			},
			AfterIntent: func(admitted Operation) {
				ConsumeRsiContinuation(e.store, admitted)
				ConsumePauseContinuation(e.store, admitted.TaskId, admitted.NodeId, admitted.Id)
				resolved := admitted.Context.AgentContext
				if resolved != nil && handoffPackage != nil {
					FreezeContextHandoff(e.store, *resolved, FreezeContextHandoffInput{
						TaskId:      admitted.TaskId,
						OperationId: admitted.Id,
						NodeId:      admitted.NodeId,
						InstanceId:  *admitted.InstanceId,
						Package:     *handoffPackage,
					})
					e.store.Event(admitted.TaskId, "context.requested", map[string]any{
						"nodeId":       admitted.NodeId,
						"operationId":  admitted.Id,
						"purpose":      string(resolved.Purpose),
						"independence": string(resolved.Independence),
						"sourceNodeId": nil,
					})
					e.store.Event(admitted.TaskId, "context.mode_selected", map[string]any{
						"nodeId":           admitted.NodeId,
						"operationId":      admitted.Id,
						"mode":             string(resolved.Mode),
						"reasonCode":       resolved.ReasonCode,
						"sourceInstanceId": nil,
					})
					e.store.Event(admitted.TaskId, "context.handoff_frozen", map[string]any{
						"nodeId":            admitted.NodeId,
						"operationId":       admitted.Id,
						"handoffId":         resolved.HandoffId,
						"digest":            resolved.HandoffDigest,
						"constraintsDigest": resolved.ConstraintsDigest,
					})
				}
				if conversation != nil && len(chatMessages) > 0 {
					DeliverMessages(e.store, admitted.Id, admitted.Attempt, chatMessages)
				}
			},
		})
		return operation, true, nil
	}()
	if failure != nil {
		if refusal, ok := failure.(*RuntimeError); ok && strings.HasPrefix(refusal.Code, "context_") {
			data := map[string]any{
				"reason":        refusal.Message,
				"code":          refusal.Code,
				"requiredFacts": []any{},
				"policy":        "none",
			}
			e.store.Transaction(func() any {
				e.store.Event(node.TaskId, "context.rejected", map[string]any{"nodeId": node.Id, "data": data})
				e.block(node, "context_rejected", data, nil)
				return nil
			})
			return Operation{}, false
		}
		panic(failure)
	}
	return operation, admitted
}

// stringField reads a string field of a JSON record.
func stringField(record map[string]any, key string) string {
	if value, ok := record[key].(string); ok {
		return value
	}
	return ""
}

// optionalStringField reads an optional string field of a JSON record.
func optionalStringField(record map[string]any, key string) *string {
	if value, ok := record[key].(string); ok {
		return &value
	}
	return nil
}

// numberField reads a number field of a JSON record.
func numberField(record map[string]any, key string) float64 {
	if value, ok := record[key].(float64); ok {
		return value
	}
	return 0
}
