package graph

import (
	"sync"
	"time"
)

// TODO(port): AbortSignal is defined once, in this file. Sibling ports should use this type and not redeclare it.
// Nil is not aborted. AddEventListener does not replay an abort that already happened.

const AGENT_EXECUTION_LIMIT = 10
const PROGRAM_EXECUTION_LIMIT = 4

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

// AbortError is the DOM-shaped Error named AbortError, not a RuntimeError.
type AbortError struct{}

func (AbortError) Error() string { return "Execution slot wait aborted" }

func executionSlotsAborted() *AbortError { return &AbortError{} }

func ExecutionLimit(kind string) int {
	if kind == "agent" {
		return AGENT_EXECUTION_LIMIT
	}
	return PROGRAM_EXECUTION_LIMIT
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
		counted, _ := graphDBRow(store.Db, "SELECT COUNT(*) AS n FROM kernel_module_operations WHERE worker_active=1")
		kernel = graphDBInt(counted, "n")
	}
	return occupied + kernel
}

// WaitForAgentExecutionSlot atomically takes an Agent execution slot after a credential wait.
func WaitForAgentExecutionSlot(store *TaskStore, operationId string, signal *AbortSignal) {
	for {
		if signal.Aborted() {
			panic(executionSlotsAborted())
		}
		admitted := store.Transaction(func() any {
			if OccupiedSlots(store, "agent") >= AGENT_EXECUTION_LIMIT {
				return false
			}
			ClearOperationCredentialWait(store, operationId)
			return true
		})
		if admitted == true {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// WaitForKernelExecutionSlot yields capacity while a resident execution waits for provider credentials.
func WaitForKernelExecutionSlot(kernel *KernelStore, executionId string, signal *AbortSignal) {
	store := kernel.Store
	for {
		if signal.Aborted() {
			panic(executionSlotsAborted())
		}
		admitted := store.Transaction(func() any {
			row, ok := graphDBRow(store.Db, "SELECT e.state,t.phase FROM kernel_executions e JOIN tasks t ON t.id=e.task_id WHERE e.id=?", executionId)
			if !ok || graphDBString(row, "state") != "running" || phaseClosed(graphDBString(row, "phase")) {
				panic(executionSlotsAborted())
			}
			if OccupiedSlots(store, "agent") >= AGENT_EXECUTION_LIMIT {
				return false
			}
			kernel.SetExecutionWaiting(executionId, false)
			return true
		})
		if admitted == true {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// WaitForKernelProgramExecutionSlot reserves program capacity before a native operation crosses its send boundary.
func WaitForKernelProgramExecutionSlot(kernel *KernelStore, operationId string, signal *AbortSignal) {
	store := kernel.Store
	for {
		if signal.Aborted() {
			panic(executionSlotsAborted())
		}
		admitted := store.Transaction(func() any {
			row, ok := graphDBRow(store.Db, "SELECT o.state,o.task_id,o.module_id,t.phase,t.paused FROM kernel_module_operations o JOIN tasks t ON t.id=o.task_id WHERE o.id=?", operationId)
			if !ok || graphDBString(row, "state") != "prepared" || phaseClosed(graphDBString(row, "phase")) {
				panic(executionSlotsAborted())
			}
			paused, _ := graphDBRow(store.Db, "SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id=?", graphDBString(row, "task_id"), graphDBString(row, "module_id"))
			if graphDBInt(row, "paused") != 0 || graphDBInt(paused, "paused") != 0 {
				Raise("paused", "Program execution slot wait is paused")
			}
			if OccupiedSlots(store, "program") >= PROGRAM_EXECUTION_LIMIT {
				return false
			}
			kernel.HoldModuleOperationWorker(operationId)
			return true
		})
		if admitted == true {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func phaseClosed(phase string) bool {
	return phase == "stopping" || phase == "stopped" || phase == "completed"
}
