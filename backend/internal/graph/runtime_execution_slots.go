package graph

import (
	"sync"
)

type AbortSignal struct {
	mu        sync.Mutex
	done      chan struct{}
	aborted   bool
	listeners []*abortListener
	nextID    int
}

type abortListener struct {
	id   int
	once bool
	fn   func()
}

func NewAbortSignal() *AbortSignal {
	return &AbortSignal{done: make(chan struct{})}
}

func (s *AbortSignal) Aborted() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.aborted
}

func (s *AbortSignal) Abort() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.aborted {
		s.mu.Unlock()
		return
	}
	s.aborted = true
	close(s.done)
	listeners := s.listeners
	s.listeners = nil
	s.mu.Unlock()
	for _, listener := range listeners {
		listener.fn()
	}
}

func (s *AbortSignal) Done() <-chan struct{} {
	if s == nil {
		return nil
	}
	return s.done
}

func (s *AbortSignal) AddEventListener(event string, fn func(), once bool) *abortListener {
	if s == nil || event != "abort" || fn == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	listener := &abortListener{id: s.nextID, once: once, fn: fn}
	s.listeners = append(s.listeners, listener)
	return listener
}

func (s *AbortSignal) RemoveEventListener(listener *abortListener) {
	if s == nil || listener == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.listeners[:0]
	for _, item := range s.listeners {
		if item.id != listener.id {
			next = append(next, item)
		}
	}
	s.listeners = next
}

type AbortError struct{}

func (AbortError) Error() string { return "Execution slot wait aborted" }

func executionSlotsAborted() *AbortError { return &AbortError{} }

var runtimeLeaseEpoch = NowMillis()

type executionSlotPool struct {
	mu      sync.Mutex
	limiter *ExecutionLimiter
	owners  map[string]bool
}

func newExecutionSlotPool(limit int) *executionSlotPool {
	return &executionSlotPool{limiter: NewExecutionLimiter(limit), owners: map[string]bool{}}
}

func (pool *executionSlotPool) acquire(owner string, signal *AbortSignal) error {
	pool.mu.Lock()
	held := pool.owners[owner]
	pool.mu.Unlock()
	if held {
		return nil
	}
	release, err := pool.limiter.Acquire(signal)
	if err != nil {
		return err
	}
	pool.mu.Lock()
	if pool.owners[owner] {
		pool.mu.Unlock()
		release()
		return nil
	}
	pool.owners[owner] = true
	pool.mu.Unlock()
	return nil
}

func (pool *executionSlotPool) release(owner string) {
	pool.mu.Lock()
	if !pool.owners[owner] {
		pool.mu.Unlock()
		return
	}
	delete(pool.owners, owner)
	pool.mu.Unlock()
	pool.limiter.Release()
}

func (pool *executionSlotPool) reserve(owner string) {
	pool.mu.Lock()
	if pool.owners[owner] {
		pool.mu.Unlock()
		return
	}
	pool.owners[owner] = true
	pool.mu.Unlock()
	pool.limiter.holdExisting()
}

func (store *TaskStore) agentSlotPool() *executionSlotPool {
	return store.agentExecutions
}

func (store *TaskStore) programSlotPool() *executionSlotPool {
	return store.programExecutions
}

func (store *TaskStore) executionSlotPool(kind string) *executionSlotPool {
	if kind == "agent" {
		return store.agentSlotPool()
	}
	return store.programSlotPool()
}

func ExecutionLimit(store *TaskStore, kind string) int {
	return store.executionSlotPool(kind).limiter.Limit()
}

func (store *TaskStore) SetExecutionLimits(agent, program int) {
	if agent < 1 {
		agent = DefaultAgentExecutions
	}
	if program < 1 {
		program = DefaultProgramExecutions
	}
	store.agentSlotPool().limiter.SetLimit(agent)
	store.programSlotPool().limiter.SetLimit(program)
}

func (store *TaskStore) FreeExecutionSlots(kind string) int {
	return store.executionSlotPool(kind).limiter.FreeSlots()
}

func (store *TaskStore) ExecutionSlotsUsed(kind string) int {
	return store.executionSlotPool(kind).limiter.Used()
}

func (store *TaskStore) ExecutionSlotsWaiting(kind string) int {
	return store.executionSlotPool(kind).limiter.Waiting()
}

func OccupiedSlots(store *TaskStore, kind string) int64 {
	agent := 0
	if kind == "agent" {
		agent = 1
	}
	row, _ := graphDBRow(store.Db, `SELECT COUNT(*) AS occupied FROM operations
    WHERE (state='intent' OR (worker_active=1 AND waiting_slot=0)) AND (instance_id IS NOT NULL)=?`, agent)
	occupied := graphDBInt(row, "occupied")
	_, hasKernel := graphDBRow(store.Db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_executions'")
	var kernel int64
	if kind == "agent" && hasKernel {
		counted, _ := graphDBRow(store.Db, "SELECT COUNT(*) AS n FROM kernel_executions WHERE state='running' AND waiting_slot=0")
		kernel = graphDBInt(counted, "n")
	} else if kind == "program" && hasKernel {
		counted, _ := graphDBRow(store.Db, "SELECT COUNT(*) AS n FROM kernel_module_operations WHERE worker_active=1 AND state IN ('prepared','dispatched')")
		kernel = graphDBInt(counted, "n")
	}
	return occupied + kernel
}

func (store *TaskStore) RebuildExecutionSlots() {
	if store.IsTransaction() {
		Raise("invalid_runtime", "Execution slot occupancy cannot be rebuilt inside a transaction")
	}
	for _, id := range store.executionSlotOwners("kernel_executions", "state='running' AND waiting_slot=0") {
		store.agentSlotPool().reserve("exec:" + id)
	}
	for _, id := range store.executionSlotOwners("operations", "instance_id IS NOT NULL AND (state='intent' OR (worker_active=1 AND waiting_slot=0))") {
		store.agentSlotPool().reserve("op:" + id)
	}
	for _, id := range store.executionSlotOwners("operations", "instance_id IS NULL AND (state='intent' OR (worker_active=1 AND waiting_slot=0))") {
		store.programSlotPool().reserve("op:" + id)
	}
	for _, id := range store.executionSlotOwners("kernel_module_operations", "worker_active=1 AND state IN ('prepared','dispatched')") {
		store.programSlotPool().reserve("prog:" + id)
	}
}

func (store *TaskStore) executionSlotOwners(table, predicate string) []string {
	if !store.hasTable(table) {
		return nil
	}
	rows, err := store.Db.Query("SELECT id FROM " + table + " WHERE " + predicate)
	if err != nil {
		Raise("invalid_runtime", "Execution slot occupancy could not be read from "+table+": "+err.Error())
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			Raise("invalid_runtime", "Execution slot occupancy could not be read from "+table+": "+err.Error())
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		Raise("invalid_runtime", "Execution slot occupancy could not be read from "+table+": "+err.Error())
	}
	return ids
}

func (store *TaskStore) hasTable(name string) bool {
	row, ok := graphDBRow(store.Db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name)
	return ok && row != nil
}

func WaitForAgentExecutionSlot(store *TaskStore, operationId string, signal *AbortSignal) {
	if signal.Aborted() {
		panic(executionSlotsAborted())
	}
	if err := store.agentSlotPool().acquire("op:"+operationId, signal); err != nil {
		panic(err)
	}
	ClearOperationCredentialWait(store, operationId)
}

func WaitForKernelExecutionSlot(kernel *KernelStore, executionId string, signal *AbortSignal) {
	store := kernel.Store
	if signal.Aborted() {
		panic(executionSlotsAborted())
	}
	row, ok := graphDBRow(store.Db, "SELECT e.state,t.phase FROM kernel_executions e JOIN tasks t ON t.id=e.task_id WHERE e.id=?", executionId)
	if !ok || graphDBString(row, "state") != "running" || phaseClosed(graphDBString(row, "phase")) {
		panic(executionSlotsAborted())
	}
	if err := store.agentSlotPool().acquire("exec:"+executionId, signal); err != nil {
		panic(err)
	}
	latest, ok := graphDBRow(store.Db, "SELECT e.state,t.phase FROM kernel_executions e JOIN tasks t ON t.id=e.task_id WHERE e.id=?", executionId)
	if !ok || graphDBString(latest, "state") != "running" || phaseClosed(graphDBString(latest, "phase")) {
		ReleaseKernelExecutionSlot(kernel, executionId)
		panic(executionSlotsAborted())
	}
	kernel.SetExecutionWaiting(executionId, false)
}

func WaitForKernelProgramExecutionSlot(kernel *KernelStore, operationId string, signal *AbortSignal) {
	store := kernel.Store
	ReclaimStaleOperationLeases(kernel, "lease_stale")
	if signal.Aborted() {
		panic(executionSlotsAborted())
	}
	row, ok := graphDBRow(store.Db, "SELECT o.state,o.task_id,o.module_id,t.phase,t.paused FROM kernel_module_operations o JOIN tasks t ON t.id=o.task_id WHERE o.id=?", operationId)
	if !ok || graphDBString(row, "state") != "prepared" || phaseClosed(graphDBString(row, "phase")) {
		panic(executionSlotsAborted())
	}
	paused, _ := graphDBRow(store.Db, "SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id=?", graphDBString(row, "task_id"), graphDBString(row, "module_id"))
	if graphDBInt(row, "paused") != 0 || graphDBInt(paused, "paused") != 0 {
		Raise("paused", "Program execution slot wait is paused")
	}
	if err := store.programSlotPool().acquire("prog:"+operationId, signal); err != nil {
		panic(err)
	}
	latest, ok := graphDBRow(store.Db, "SELECT o.state,o.task_id,o.module_id,t.phase,t.paused FROM kernel_module_operations o JOIN tasks t ON t.id=o.task_id WHERE o.id=?", operationId)
	if !ok || graphDBString(latest, "state") != "prepared" || phaseClosed(graphDBString(latest, "phase")) {
		ReleaseKernelProgramExecutionSlot(kernel, operationId)
		panic(executionSlotsAborted())
	}
	pausedNow, _ := graphDBRow(store.Db, "SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id=?", graphDBString(latest, "task_id"), graphDBString(latest, "module_id"))
	if graphDBInt(latest, "paused") != 0 || graphDBInt(pausedNow, "paused") != 0 {
		ReleaseKernelProgramExecutionSlot(kernel, operationId)
		Raise("paused", "Program execution slot wait is paused")
	}
	kernel.HoldModuleOperationWorker(operationId)
}

func ReleaseKernelExecutionSlot(kernel *KernelStore, executionId string) {
	kernel.Store.agentSlotPool().release("exec:" + executionId)
}

func ReleaseKernelProgramExecutionSlot(kernel *KernelStore, operationId string) {
	kernel.Store.programSlotPool().release("prog:" + operationId)
}

func ReleaseOperationExecutionSlots(store *TaskStore, operationId string) {
	store.agentSlotPool().release("op:" + operationId)
	store.programSlotPool().release("prog:" + operationId)
}

func phaseClosed(phase string) bool {
	return phase == "stopping" || phase == "stopped" || phase == "completed"
}
