package graph

func (l *OperationLifecycle) Admit(input OperationAdmitInput) Operation {
	return l.transaction(func() any {
		if input.Reservation < 0 {
			Raise("invalid_adapter", "A bounded token reservation is required")
		}
		row := kernelRow(l.store.Db, "SELECT COUNT(*) AS count FROM operations WHERE task_id=? AND node_id=?", input.Node.TaskId, input.Node.Id)
		attempt := int(kernelInt(row["count"])) + 1
		operation := input.Prepare(attempt).operation(graphUUID(), l.generation, attempt)
		l.store.RecordOperationIntent(operation.Id, operation.TaskId, operation.NodeId, operation.InstanceId, operation.Generation, CanonicalJSON(operation), 0, operation.ActivationId)
		ReserveOperation(l.store, operation.Id, input.Reservation)
		if input.AfterIntent != nil {
			input.AfterIntent(operation)
		}
		l.store.PrepareActivation(operation.ActivationId, CanonicalJSON(operation.InputVersions))
		l.store.SetNodePreparing(operation.TaskId, operation.NodeId)
		l.store.Event(operation.TaskId, "operation.intent", OperationIntentEvent(operation))
		return operation
	}).(Operation)
}

type operationNotSentOptions struct {
	ResetNode   bool
	EventReason *string
}

func (l *OperationLifecycle) markNotSent(row map[string]any, options operationNotSentOptions) {
	now := NowMillis()
	id := kernelString(row["id"])
	ClearConversationStream(l.store, id)
	l.store.MarkOperationUnsent(id, "not_sent", now)
	ReleaseOperationReservation(l.store, id)
	ReleaseRsiContinuation(l.store, id)
	ReleaseWakes(l.store, id)
	if options.ResetNode {
		l.store.SetNodePending(kernelString(row["task_id"]), kernelString(row["node_id"]))
	}
	if options.EventReason != nil {
		l.store.Event(kernelString(row["task_id"]), "operation.not_sent", map[string]any{"operationId": id, "reason": *options.EventReason})
	}
}
