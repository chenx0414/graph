package graph

import (
	"context"
	"fmt"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// The PiG kernel's recovery of a graph node.
//
// A node's turn is the same turn the main agent runs: its own identity, its
// own transcript, its own admission, all on the same kernel. The three facts
// decide the same way they decide for the main agent.
//
//   - A turn the kernel finished is an answer the Graph already paid for. The
//     node runs again against the same admission, the kernel hands back the
//     answer it kept, and the model is not asked a second time.
//   - A turn the kernel accepted but never sent is sent again, with the
//     configuration it was admitted with - not the configuration the catalog
//     happens to hold now.
//   - A turn that was already at the model is neither. The credential was
//     spent and the side effects may have happened, so the input is not sent
//     again and the node waits for the user.
//
// The recovery restores the frozen configuration into the lane, so the node's
// re-run is the turn it was admitted as.

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
	switch {
	case receipt.Completed:
		// The kernel finished the turn. The node runs again against the same
		// admission and the kernel answers from what it kept.
		//
		// The execution carries a submission, so the executor would refuse
		// to start it again without proof that the turn is still there. The
		// kernel's receipt is that proof.
		markDurableNodeCompletion(runtime.store.Path, execution.Id)
		runtime.restorePigNode(frozen)
		runtime.requeuePigNode(execution)
	case pigNodeCalledProvider(runtime.kernel, execution, frozen):
		// The turn was at the model. It is not sent again.
		runtime.stopPigNode(execution)
	default:
		// The turn was accepted and never sent. It is sent again.
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
	if _, err := PrepareDurableNodeRecovery(runtime.store.Path, wrapper); err != nil {
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
		kernelExec(runtime.store.Db, "UPDATE kernel_executions SET state='blocked' WHERE id=? AND state='failed'", execution.Id)
		kernelExec(runtime.store.Db, "UPDATE kernel_queue SET state='queued',reason='Original kernel receipt retained for settlement' WHERE task_id=? AND node_id=? AND state='failed'",
			execution.TaskId, execution.NodeId)
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
		kernelExec(runtime.store.Db, "UPDATE kernel_queue SET state='failed',reason=? WHERE task_id=? AND node_id=? AND state IN ('queued','claimed')",
			pigNodeStoppedReason, execution.TaskId, execution.NodeId)
		kernelExec(runtime.store.Db, "UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?", execution.TaskId, execution.NodeId)
		kernelExec(runtime.store.Db, "UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')", execution.TaskId)
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
	pre := map[string]bool{}
	for _, id := range durableStrings(frozen.Record["preAdmissionInvocationIds"]) {
		pre[id] = true
	}
	for _, call := range kernelRows(kernel.Db, "SELECT id FROM kernel_provider_calls WHERE execution_id=?", execution.Id) {
		if !pre[kernelString(call["id"])] {
			return true
		}
	}
	return false
}

// pigNodeRestoredWrapper is the shape the lane reads a restored node from.
//
// The lane already knows this shape: the TypeScript sidecar's frozen
// executions carry it, and the PiG kernel's frozen records hold the same
// facts under the kernel's own names. The translation is the whole point: the
// node's re-run must use the configuration it was admitted with.
func pigNodeRestoredWrapper(frozen pigkernel.FrozenExecution) map[string]any {
	record := frozen.Record
	configuration := asMap(record["configuration"])
	snapshot := map[string]any{
		"identity":    frozen.Identity,
		"executionId": frozen.ExecutionId,
		"model":       record["model"],
		"agent":       record["agent"],
		"configuration": map[string]any{
			"policy": map[string]any{
				"binding": map[string]any{"instanceId": frozen.Identity},
			},
			"nodeExecutionConfiguration": configuration["executionConfiguration"],
			"credentialReference":        configuration["credentialReference"],
			"descriptor":                 configuration["descriptor"],
		},
	}
	return map[string]any{
		"snapshot":           snapshot,
		"restoredPolicy":     asMap(record["policy"]),
		"restoredDescriptor": configuration["descriptor"],
	}
}
