// graph:table-writes-exempt: a test seeds the rows its subject restores
package graph

import (
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func awaitSlotState(t *testing.T, settled func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !settled() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		runtime.Gosched()
	}
}

func slotWaitFailure(action func()) (failure error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		err, ok := recovered.(error)
		if !ok {
			panic(recovered)
		}
		failure = err
	}()
	action()
	return nil
}

func seedRunningExecution(t *testing.T, kernel *KernelStore, id string, waiting bool) {
	t.Helper()
	kernelExec(kernel.Db, `INSERT INTO kernel_executions(id,task_id,node_id,revision_version,attempt,state,started_at,run_ms,waiting_ms)
		VALUES(?,'task','node',1,0,'running',?,0,0)`, id, NowMillis())
	if waiting {
		kernelExec(kernel.Db, "UPDATE kernel_executions SET waiting_slot=1 WHERE id=?", id)
	}
}

func TestTaskStoreDefaultsAndInjectsExecutionLimits(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	if limit := ExecutionLimit(store, "agent"); limit != 1024 {
		t.Fatalf("the agent default is 1024, got %d", limit)
	}
	if limit := ExecutionLimit(store, "program"); limit != 4 {
		t.Fatalf("the program default is 4, got %d", limit)
	}
	if free := store.FreeExecutionSlots("agent"); free != 1024 {
		t.Fatalf("an idle store has every agent slot free, got %d", free)
	}
	store.SetExecutionLimits(7, 2)
	if limit := ExecutionLimit(store, "agent"); limit != 7 {
		t.Fatalf("the injected agent limit reads back, got %d", limit)
	}
	if limit := ExecutionLimit(store, "program"); limit != 2 {
		t.Fatalf("the injected program limit reads back, got %d", limit)
	}
	if free := store.FreeExecutionSlots("agent"); free != 7 {
		t.Fatalf("the injected limit bounds the pool, got %d free", free)
	}
	store.SetExecutionLimits(0, 0)
	if limit := ExecutionLimit(store, "agent"); limit != 1024 {
		t.Fatalf("a zero limit falls back to the documented default, got %d", limit)
	}
	if limit := ExecutionLimit(store, "program"); limit != 4 {
		t.Fatalf("a zero program limit falls back to 4, got %d", limit)
	}
}

func TestRebuildExecutionSlotsCountsActiveWorkAndSkipsWaiting(t *testing.T) {
	kernel, closeStore := newTestKernel(t)
	defer closeStore()
	store := kernel.Store
	seedRunningExecution(t, kernel, "exec-a", false)
	seedRunningExecution(t, kernel, "exec-b", false)
	seedRunningExecution(t, kernel, "exec-waiting", true)
	kernelExec(kernel.Db, "INSERT INTO nodes(task_id,id,spec) VALUES('task','node','{}')")
	kernelExec(kernel.Db, "INSERT INTO instances(id,task_id,node_id,budget,used) VALUES('inst','task','node',20000000,0)")
	kernelExec(kernel.Db, `INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active)
		VALUES('op-a','task','node','inst',0,'{}','intent',0,0)`)
	kernelExec(kernel.Db, `INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active,waiting_slot)
		VALUES('op-waiting','task','node','inst',0,'{}','dispatched',0,1,1)`)
	kernelExec(kernel.Db, `INSERT INTO kernel_module_operations(id,task_id,module_id,delivery_id,revision_version,request,state,created_at,worker_active)
		VALUES('prog-a','task','module','delivery',1,'{}','dispatched',?,1)`, NowMillis())

	store.RebuildExecutionSlots()
	if used := store.ExecutionSlotsUsed("agent"); used != 3 {
		t.Fatalf("two running executions and one intent operation occupy three agent slots, got %d", used)
	}
	if used := store.ExecutionSlotsUsed("program"); used != 1 {
		t.Fatalf("the active program operation occupies one program slot, got %d", used)
	}
	if occupied := OccupiedSlots(store, "agent"); occupied != int64(store.ExecutionSlotsUsed("agent")) {
		t.Fatalf("the statistics view agrees with the restored occupancy, %d vs %d", occupied, store.ExecutionSlotsUsed("agent"))
	}
	ReleaseKernelExecutionSlot(kernel, "exec-a")
	ReleaseKernelExecutionSlot(kernel, "exec-b")
	ReleaseOperationExecutionSlots(store, "op-a")
	ReleaseKernelProgramExecutionSlot(kernel, "prog-a")
	if used := store.ExecutionSlotsUsed("agent"); used != 0 {
		t.Fatalf("releasing every restored lease empties the agent pool, got %d", used)
	}
	if used := store.ExecutionSlotsUsed("program"); used != 0 {
		t.Fatalf("releasing the program lease empties the program pool, got %d", used)
	}
}

func TestWaitForKernelExecutionSlotHoldsOneLeasePerExecution(t *testing.T) {
	kernel, closeStore := newTestKernel(t)
	defer closeStore()
	store := kernel.Store
	store.SetExecutionLimits(2, 1)
	seedRunningExecution(t, kernel, "exec-a", false)
	seedRunningExecution(t, kernel, "exec-b", false)
	seedRunningExecution(t, kernel, "exec-c", false)
	signal := NewAbortSignal()
	WaitForKernelExecutionSlot(kernel, "exec-a", signal)
	WaitForKernelExecutionSlot(kernel, "exec-a", signal)
	if used := store.ExecutionSlotsUsed("agent"); used != 1 {
		t.Fatalf("one execution holds one lease across provider calls, got %d", used)
	}
	WaitForKernelExecutionSlot(kernel, "exec-b", signal)
	if used := store.ExecutionSlotsUsed("agent"); used != 2 {
		t.Fatalf("two executions hold two leases, got %d", used)
	}
	woken := make(chan error, 1)
	go func() {
		woken <- slotWaitFailure(func() { WaitForKernelExecutionSlot(kernel, "exec-c", signal) })
	}()
	awaitSlotState(t, func() bool { return store.ExecutionSlotsWaiting("agent") == 1 }, "the third execution to queue")
	select {
	case failure := <-woken:
		t.Fatalf("the third execution must wait for a slot, it returned with %v", failure)
	default:
	}
	ReleaseKernelExecutionSlot(kernel, "exec-a")
	if failure := <-woken; failure != nil {
		t.Fatalf("the blocked execution wakes when a lease is released, got %v", failure)
	}
	if used := store.ExecutionSlotsUsed("agent"); used != 2 {
		t.Fatalf("the woken execution holds the released lease, got %d", used)
	}
	ReleaseKernelExecutionSlot(kernel, "exec-b")
	ReleaseKernelExecutionSlot(kernel, "exec-c")
	if used := store.ExecutionSlotsUsed("agent"); used != 0 {
		t.Fatalf("releasing every lease empties the pool, got %d", used)
	}
}

func TestWaitForKernelExecutionSlotCancellationLeavesNoLease(t *testing.T) {
	kernel, closeStore := newTestKernel(t)
	defer closeStore()
	store := kernel.Store
	store.SetExecutionLimits(1, 1)
	seedRunningExecution(t, kernel, "exec-a", false)
	seedRunningExecution(t, kernel, "exec-b", false)
	WaitForKernelExecutionSlot(kernel, "exec-a", NewAbortSignal())
	signal := NewAbortSignal()
	cancelled := make(chan error, 1)
	go func() {
		cancelled <- slotWaitFailure(func() { WaitForKernelExecutionSlot(kernel, "exec-b", signal) })
	}()
	awaitSlotState(t, func() bool { return store.ExecutionSlotsWaiting("agent") == 1 }, "the cancelled execution to queue")
	signal.Abort()
	failure := <-cancelled
	if _, ok := failure.(*AbortError); !ok {
		t.Fatalf("a cancelled slot wait reports the abort error, got %v", failure)
	}
	if used := store.ExecutionSlotsUsed("agent"); used != 1 {
		t.Fatalf("cancellation leaves the held lease untouched, got %d", used)
	}
	if waiting := store.ExecutionSlotsWaiting("agent"); waiting != 0 {
		t.Fatalf("a cancelled waiter leaves the queue, got %d waiting", waiting)
	}
	ReleaseKernelExecutionSlot(kernel, "exec-a")
	if free := store.FreeExecutionSlots("agent"); free != 1 {
		t.Fatalf("the cancelled wait leaked no slot, got %d free", free)
	}
}

func TestWaitForKernelExecutionSlotRejectsAClosedExecution(t *testing.T) {
	kernel, closeStore := newTestKernel(t)
	defer closeStore()
	kernelExec(kernel.Db, `INSERT INTO kernel_executions(id,task_id,node_id,revision_version,attempt,state,started_at,run_ms,waiting_ms)
		VALUES('exec-done','task','node',1,0,'completed',?,0,0)`, NowMillis())
	failure := slotWaitFailure(func() { WaitForKernelExecutionSlot(kernel, "exec-done", NewAbortSignal()) })
	if _, ok := failure.(*AbortError); !ok {
		t.Fatalf("a finished execution cannot take a slot, got %v", failure)
	}
	if used := kernel.Store.ExecutionSlotsUsed("agent"); used != 0 {
		t.Fatalf("a refused execution holds no lease, got %d", used)
	}
}

func TestWaitForAgentExecutionSlotHoldsOneLeasePerOperation(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	store.SetExecutionLimits(2, 4)
	WaitForAgentExecutionSlot(store, "op-a", NewAbortSignal())
	WaitForAgentExecutionSlot(store, "op-a", NewAbortSignal())
	if used := store.ExecutionSlotsUsed("agent"); used != 1 {
		t.Fatalf("one operation holds one lease across provider calls, got %d", used)
	}
	WaitForAgentExecutionSlot(store, "op-b", NewAbortSignal())
	if used := store.ExecutionSlotsUsed("agent"); used != 2 {
		t.Fatalf("two operations hold two leases, got %d", used)
	}
	woken := make(chan error, 1)
	go func() {
		woken <- slotWaitFailure(func() { WaitForAgentExecutionSlot(store, "op-c", NewAbortSignal()) })
	}()
	awaitSlotState(t, func() bool { return store.ExecutionSlotsWaiting("agent") == 1 }, "the third operation to queue")
	ReleaseOperationExecutionSlots(store, "op-a")
	if failure := <-woken; failure != nil {
		t.Fatalf("the queued operation wakes on release, got %v", failure)
	}
	ReleaseOperationExecutionSlots(store, "op-b")
	ReleaseOperationExecutionSlots(store, "op-c")
	if used := store.ExecutionSlotsUsed("agent"); used != 0 {
		t.Fatalf("the agent pool empties, got %d", used)
	}
	ReleaseOperationExecutionSlots(store, "op-unknown")
	if used := store.ExecutionSlotsUsed("agent"); used != 0 {
		t.Fatalf("releasing an unknown owner is harmless, got %d", used)
	}
}

func TestWaitForKernelProgramExecutionSlotHoldsTheProgramLimit(t *testing.T) {
	kernel, closeStore := newTestKernel(t)
	defer closeStore()
	store := kernel.Store
	store.SetExecutionLimits(1024, 1)
	now := NowMillis()
	for _, id := range []string{"prog-a", "prog-b"} {
		kernelExec(kernel.Db, `INSERT INTO kernel_module_operations(id,task_id,module_id,delivery_id,revision_version,request,state,created_at,worker_active)
			VALUES(?,'task','module',?,1,'{}','prepared',?,0)`, id, "delivery-"+id, now)
	}
	WaitForKernelProgramExecutionSlot(kernel, "prog-a", NewAbortSignal())
	WaitForKernelProgramExecutionSlot(kernel, "prog-a", NewAbortSignal())
	if used := store.ExecutionSlotsUsed("program"); used != 1 {
		t.Fatalf("one program operation holds one lease, got %d", used)
	}
	woken := make(chan error, 1)
	go func() {
		woken <- slotWaitFailure(func() { WaitForKernelProgramExecutionSlot(kernel, "prog-b", NewAbortSignal()) })
	}()
	awaitSlotState(t, func() bool { return store.ExecutionSlotsWaiting("program") == 1 }, "the second program operation to queue")
	ReleaseKernelProgramExecutionSlot(kernel, "prog-a")
	if failure := <-woken; failure != nil {
		t.Fatalf("the queued program operation wakes on release, got %v", failure)
	}
	if used := store.ExecutionSlotsUsed("program"); used != 1 {
		t.Fatalf("the woken program operation holds the released lease, got %d", used)
	}
	ReleaseKernelProgramExecutionSlot(kernel, "prog-b")
	if used := store.ExecutionSlotsUsed("program"); used != 0 {
		t.Fatalf("the program pool empties, got %d", used)
	}
}
