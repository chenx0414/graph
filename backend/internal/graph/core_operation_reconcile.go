package graph

import (
	"strings"
)

func (l *OperationLifecycle) CancelBeforeDispatch(operationId, reason string) {
	if reason == "" {
		reason = "Cancelled before dispatch"
	}
	l.transaction(func() any {
		row := l.operationRow(operationId)
		l.markNotSent(row, operationNotSentOptions{ResetNode: true, EventReason: operationLifecycleStringPtr(reason)})
		ReleaseMessages(l.store, operationId)
		return nil
	})
}

func (l *OperationLifecycle) MarkPreparationFailed(operationId, reason string) {
	l.transaction(func() any {
		row := l.operationRow(operationId)
		l.markNotSent(row, operationNotSentOptions{ResetNode: false})
		ReleaseMessages(l.store, operationId)
		l.Block(kernelString(row["task_id"]), kernelString(row["node_id"]), "adapter_error", map[string]any{"reason": reason}, operationLifecycleStringPtr(operationId))
		RecordConversationInterruption(l.store, operationFrom(row), reason, "setup")
		return nil
	})
}

func (l *OperationLifecycle) Dispatch(operation Operation) {
	l.transaction(func() any {
		now := NowMillis()
		l.store.MarkOperationDispatchedAt(operation.Id, now)
		l.store.SetNodeRunning(operation.TaskId, operation.NodeId)
		l.store.RunActivation(operation.ActivationId)
		l.store.Event(operation.TaskId, "operation.dispatched", map[string]any{"operationId": operation.Id})
		if operation.Context.RsiContinuation != nil {
			l.store.Event(operation.TaskId, "rsi.continuation_dispatched", map[string]any{
				"requestId":   operation.Context.RsiContinuation.RequestId,
				"operationId": operation.Id,
			})
		}
		return nil
	})
}

func (l *OperationLifecycle) Report(id string, generation int, result OperationResult) string {
	return l.transaction(func() any {
		row := l.operationRow(id)
		if int(kernelInt(row["generation"])) != generation || generation != l.generation {
			Raise("stale_generation", "Worker generation is stale")
		}
		operation := operationFrom(row)
		l.settle(operation, result, operationSettleOptions{})
		return operation.TaskId
	}).(string)
}

func (l *OperationLifecycle) Steer(operationId string, steer func(operation Operation) *int64) *int64 {
	row := l.operationRow(operationId)
	if kernelString(row["state"]) != "dispatched" || kernelInt(row["worker_active"]) == 0 {
		Raise("no_active_operation", "The master Agent is no longer accepting steering messages")
	}
	return steer(operationFrom(row))
}

func (l *OperationLifecycle) Interrupt(operationId string, interrupt func(operation Operation) *int64) *int64 {
	row := l.operationRow(operationId)
	if kernelString(row["state"]) != "dispatched" || kernelInt(row["worker_active"]) == 0 {
		Raise("no_active_operation", "The master Agent is no longer accepting interruption")
	}
	return interrupt(operationFrom(row))
}

func (l *OperationLifecycle) Reconcile(id string, reconcile func(operation Operation) Reconciliation, integrate func(operation Operation)) string {
	row := l.operationRow(id)
	if kernelString(row["state"]) != "unknown" {
		return kernelString(row["task_id"])
	}
	operation := operationFrom(row)
	evidence := reconcile(operation)
	if strings.TrimSpace(evidence.Proof) == "" {
		Raise("invalid_reconciliation", "Reconciliation requires evidence")
	}
	if evidence.State == "completed" && integrate != nil && operation.Kind == "agent" &&
		evidence.Result != nil && evidence.Result.Outcome == "completed" {
		integrate(operation)
	}
	l.transaction(func() any {
		current := kernelRow(l.store.Db, "SELECT state,result FROM operations WHERE id=?", id)
		if kernelString(current["state"]) != "unknown" {
			return nil
		}
		if evidence.State == "completed" {
			if !evidence.Quiescent {
				Raise("invalid_reconciliation", "Completion must prove the worker is quiescent")
			}
			if evidence.Result == nil {
				Raise("invalid_reconciliation", "Completion requires a result")
			}
			l.settle(operation, *evidence.Result, operationSettleOptions{})
		} else if evidence.State == "not_started" {
			if !evidence.Quiescent || current["result"] != nil {
				Raise("invalid_reconciliation", "Cannot retry an operation with a known result or a live worker")
			}
			l.markNotSent(l.operationRow(id), operationNotSentOptions{ResetNode: true})
			l.store.ResolveOperationQuestions(id, evidence)
			CloseUserWaitForOperation(l.store, id)
		} else {
			active := 0
			if !evidence.Quiescent {
				active = 1
			}
			l.store.SetOperationWorker(id, active)
		}
		l.store.Event(operation.TaskId, "operation.reconciled", map[string]any{"operationId": id, "evidence": evidence})
		return nil
	})
	return operation.TaskId
}
