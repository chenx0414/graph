package graph

// AwaitRsiReload records a waiting continuation inside the caller's transaction.
func AwaitRsiReload(store *TaskStore, requestID, operationID, commit string) {
	g5Exec(store.Db, `INSERT OR IGNORE INTO rsi_continuations(request_id,operation_id,task_id,node_id,commit_sha,state)
    SELECT ?,o.id,o.task_id,o.node_id,?,'waiting' FROM operations o JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
    WHERE o.id=? AND json_extract(n.spec,'$.role')='master'`, requestID, commit, operationID)
}

// ConfirmRsiContinuation commits the confirmation and the durable wake together.
func ConfirmRsiContinuation(store *TaskStore, requestID string) {
	row, ok := g5One(store.Db, `SELECT r.task_id,r.node_id,t.phase,c.archived_at
    FROM rsi_continuations r JOIN tasks t ON t.id=r.task_id JOIN conversations c ON c.anchor_task_id=t.id
    WHERE r.request_id=? AND r.state='waiting'`, requestID)
	if !ok {
		return
	}
	eligible := g5Str(row["phase"]) == "chatting" && row["archived_at"] == nil
	state := "cancelled"
	if eligible {
		state = "ready"
	}
	g5Exec(store.Db, "UPDATE rsi_continuations SET state=? WHERE request_id=?", state, requestID)
	if !eligible {
		return
	}
	g5Exec(store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=? AND status='succeeded'", row["task_id"], row["node_id"])
	store.Event(g5Str(row["task_id"]), "rsi.continuation_ready", map[string]any{"requestId": requestID, "nodeId": g5Str(row["node_id"])})
}

// PendingRsiContinuation is the oldest ready continuation for a node.
func PendingRsiContinuation(store *TaskStore, taskID, nodeID string) *RsiContinuation {
	row, ok := g5One(store.Db, `SELECT request_id AS requestId,operation_id AS operationId,commit_sha AS "commit"
    FROM rsi_continuations WHERE task_id=? AND node_id=? AND state='ready' ORDER BY rowid LIMIT 1`, taskID, nodeID)
	if !ok {
		return nil
	}
	return &RsiContinuation{RequestId: g5Str(row["requestId"]), OperationId: g5Str(row["operationId"]), Commit: g5Str(row["commit"])}
}

// ConsumeRsiContinuation binds the wake-up to the operation that consumes queued messages.
func ConsumeRsiContinuation(store *TaskStore, operation Operation) {
	if operation.Context.RsiContinuation == nil {
		return
	}
	continuation := operation.Context.RsiContinuation
	g5Exec(store.Db, "UPDATE rsi_continuations SET state='consumed',resumed_operation_id=? WHERE request_id=? AND state='ready'", operation.Id, continuation.RequestId)
	store.Event(operation.TaskId, "rsi.continuation_claimed", map[string]any{"requestId": continuation.RequestId, "operationId": operation.Id})
}

// ReleaseRsiContinuation returns a consumed intent to ready when dispatch did not happen.
func ReleaseRsiContinuation(store *TaskStore, operationID string) {
	g5Exec(store.Db, "UPDATE rsi_continuations SET state='ready',resumed_operation_id=NULL WHERE resumed_operation_id=? AND state='consumed'", operationID)
}
