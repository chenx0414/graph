package graph

// Admit creates the durable intent before any adapter can cause an external effect.
func (l *OperationLifecycle) Admit(input OperationAdmitInput) Operation {
	return l.transaction(func() any {
		if input.Reservation < 0 {
			Raise("invalid_adapter", "A bounded token reservation is required")
		}
		row := kernelRow(l.store.Db, "SELECT COUNT(*) AS count FROM operations WHERE task_id=? AND node_id=?", input.Node.TaskId, input.Node.Id)
		attempt := int(kernelInt(row["count"])) + 1
		operation := input.Prepare(attempt).operation(graphUUID(), l.generation, attempt)
		kernelExec(l.store.Db, `INSERT INTO operations(
        id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id
      ) VALUES(?,?,?,?,?,?,'intent',?,?)`,
			operation.Id,
			operation.TaskId,
			operation.NodeId,
			operation.InstanceId,
			operation.Generation,
			CanonicalJSON(operation),
			0,
			operation.ActivationId,
		)
		ReserveOperation(l.store, operation.Id, input.Reservation)
		if input.AfterIntent != nil {
			input.AfterIntent(operation)
		}
		kernelExec(l.store.Db, "UPDATE activations SET input_versions=?,state='preparing' WHERE id=?",
			CanonicalJSON(operation.InputVersions), operation.ActivationId)
		kernelExec(l.store.Db, "UPDATE nodes SET status='preparing' WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
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
	kernelExec(l.store.Db, `UPDATE operations
      SET state='not_sent',worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?)
      WHERE id=?`, now, id)
	ReleaseOperationReservation(l.store, id)
	ReleaseRsiContinuation(l.store, id)
	ReleaseWakes(l.store, id)
	if options.ResetNode {
		kernelExec(l.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=?", kernelString(row["task_id"]), kernelString(row["node_id"]))
	}
	if options.EventReason != nil {
		l.store.Event(kernelString(row["task_id"]), "operation.not_sent", map[string]any{"operationId": id, "reason": *options.EventReason})
	}
}
