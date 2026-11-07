package graph

import (
	"fmt"

	"context"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

const pigNodeStoppedReason = "Runtime interrupted after the model was reached; the credential was spent. Reconcile the unknown usage before the input is sent again."

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

func (runtime *TaskRuntime) restorePigNode(frozen pigkernel.FrozenExecution) {
	wrapper := pigNodeRestoredWrapper(frozen)
	if _, err := PrepareNodeRecovery(runtime.store.Path, wrapper); err != nil {
		reportPigRecoveryFailure("the interrupted node turn could not be restored: " + err.Error())
	}
}

func (runtime *TaskRuntime) requeuePigNode(execution *ExecutionRow) {
	runtime.store.Transaction(func() any {
		runtime.kernel.BlockFailedExecution(execution.Id)
		runtime.kernel.RequeueFailedItem(execution.TaskId, execution.NodeId, "Original kernel receipt retained for settlement")
		return nil
	})
}

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

func pigNodeCalledProvider(kernel *KernelStore, execution *ExecutionRow, frozen pigkernel.FrozenExecution) bool {
	seen := []string{}
	for _, call := range kernel.ProviderCallsOfExecution(execution.Id) {
		seen = append(seen, call.Id)
	}
	return pigCallsBeyond(frozenExecutionOfRecord(frozen.Record).PreAdmissionInvocationIds, seen)
}

func pigNodeRestoredWrapper(frozen pigkernel.FrozenExecution) *FrozenExecutionRecovery {
	return frozenExecutionRecovery(frozenExecutionOfRecord(frozen.Record), frozen.Identity)
}
