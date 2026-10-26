package graph

import (
	"fmt"

	"context"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

const pigNodeStoppedReason = "Runtime interrupted after the model was reached; the credential was spent. Reconcile the unknown usage before the input is sent again."

// recoverPigNodeExecution rebinds one interrupted node turn.
//
// The answer says whether the frozen execution belongs to a graph node. A
// frozen execution of the main agent does not, and the caller settles that
// one on its own terms.
func (runtime *TaskRuntime) recoverPigNodeExecution(frozen pigkernel.FrozenExecution) bool {
	execution := runtime.kernel.Execution(frozen.ExecutionId)
	if execution == nil {
		return false
	}
	receipt, err := pigkernel.ReadExecutionReceipt(context.Background(), runtime.store.Path, frozen)
	if err != nil {
		panic(fmt.Errorf("pig kernel: the admission of %s is not readable: %w", frozen.ExecutionId, err))
	}
	switch classifyPigTurn(receipt, pigNodeCalledProvider(runtime.kernel, execution, frozen)) {
	case pigTurnKernelDone:
		// The kernel finished the turn. The node runs again against the same
		// admission and the kernel answers from what it kept.
		//
		// The execution carries a submission, so the executor would refuse
		// to start it again without proof that the turn is still there. The
		// kernel's receipt is that proof.
		markNodeCompletion(runtime.store.Path, execution.Id)
		runtime.restorePigNode(frozen)
		runtime.requeuePigNode(execution)
	case pigTurnReachedModel:
		runtime.stopPigNode(execution)
	default:
		runtime.restorePigNode(frozen)
	}
	return true
}

// restorePigNode restores one node's frozen configuration into the lane.
//
// The lane holds the restored configuration per node, and the node's re-run
// reads it: the model it was admitted with, the workspace it worked in and
// the access policy it was given.
func (runtime *TaskRuntime) restorePigNode(frozen pigkernel.FrozenExecution) {
	wrapper := pigNodeRestoredWrapper(frozen)
	if _, err := PrepareNodeRecovery(runtime.store.Path, wrapper); err != nil {
		reportPigRecoveryFailure("the interrupted node turn could not be restored: " + err.Error())
	}
}

// requeuePigNode puts a finished node turn back on the queue.
//
// The startup recovery parks an execution whose output was already submitted:
// the work is done, but the Graph could not record that it was done. The node
// runs again against the same admission, the kernel hands back the answer it
// kept, and the Graph settles the execution the way it settles any other one.
// The model is not asked again.
func (runtime *TaskRuntime) requeuePigNode(execution *ExecutionRow) {
	runtime.store.Transaction(func() any {
		runtime.kernel.BlockFailedExecution(execution.Id)
		runtime.kernel.RequeueFailedItem(execution.TaskId, execution.NodeId, "Original kernel receipt retained for settlement")
		return nil
	})
}

// stopPigNode stops a node turn that was already at the model.
//
// The input is not sent again. The queue item is failed rather than queued,
// so the node waits for the user instead of spending the credential twice: a
// retry is the user's decision to spend it again.
//
// The kernel's own turn needs no stopping. The generation resumes from its
// checkpoint, and a request the model already received is not requested a
// second time.
func (runtime *TaskRuntime) stopPigNode(execution *ExecutionRow) {
	runtime.store.Transaction(func() any {
		runtime.kernel.FailQueuedItem(execution.TaskId, execution.NodeId, pigNodeStoppedReason)
		runtime.kernel.ParkNode(execution.TaskId, execution.NodeId)
		runtime.store.BlockTaskPhase(execution.TaskId)
		runtime.store.Event(execution.TaskId, "graph.node.recovery.stopped", map[string]any{
			"executionId": execution.Id, "nodeId": execution.NodeId, "reason": pigNodeStoppedReason,
		})
		return nil
	})
}

// pigNodeCalledProvider reports whether the node's turn reached the model.
//
// The frozen record names the provider calls that existed before the turn
// started. A call beyond them is one this turn made, and the turn must not
// be sent again.
func pigNodeCalledProvider(kernel *KernelStore, execution *ExecutionRow, frozen pigkernel.FrozenExecution) bool {
	seen := []string{}
	for _, call := range kernel.ProviderCallsOfExecution(execution.Id) {
		seen = append(seen, call.Id)
	}
	return pigCallsBeyond(frozenExecutionOfRecord(frozen.Record).PreAdmissionInvocationIds, seen)
}

// pigNodeRestoredWrapper is the shape the lane reads a restored node from.
//
// The lane already knows this shape: the TypeScript sidecar's frozen
// executions carry it, and the PiG kernel's frozen records hold the same
// facts under the kernel's own names. The translation is the whole point: the
// node's re-run must use the configuration it was admitted with.
func pigNodeRestoredWrapper(frozen pigkernel.FrozenExecution) *FrozenExecutionRecovery {
	return frozenExecutionRecovery(frozenExecutionOfRecord(frozen.Record), frozen.Identity)
}
