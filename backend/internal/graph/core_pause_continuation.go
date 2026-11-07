package graph

type PauseContinuation struct {
	RequestId   string `json:"requestId"`
	OperationId string `json:"operationId"`
}

func AwaitPauseContinuation(store *TaskStore, requestId, taskId, operationId string) bool {
	master := kernelRow(store.DB, `SELECT o.node_id FROM operations o
    JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
    WHERE o.id=? AND o.task_id=? AND json_extract(n.spec,'$.role')='master'`, operationId, taskId)
	if master == nil {
		return false
	}
	nodeId := kernelString(master["node_id"])
	kernelExec(store.DB, "DELETE FROM pause_continuations WHERE task_id=? AND node_id=? AND state='waiting'", taskId, nodeId)
	kernelExec(store.DB, `INSERT INTO pause_continuations(request_id,operation_id,task_id,node_id,state) VALUES(?,?,?,?,'waiting')`, requestId, operationId, taskId, nodeId)
	return true
}

func ResumePauseContinuations(store *TaskStore, taskId string) []map[string]any {
	rows := kernelRows(store.DB, "SELECT request_id AS requestId,node_id AS nodeId FROM pause_continuations WHERE task_id=? AND state='waiting' ORDER BY rowid", taskId)
	for _, row := range rows {
		kernelExec(store.DB, "UPDATE pause_continuations SET state='ready' WHERE request_id=? AND state='waiting'", kernelString(row["requestId"]))
		store.ResumeSucceededNode(taskId, kernelString(row["nodeId"]))
		store.Event(taskId, "pause.continuation_ready", map[string]any{"requestId": kernelString(row["requestId"]), "nodeId": kernelString(row["nodeId"])})
	}
	return rows
}

func PendingPauseContinuation(store *TaskStore, taskId, nodeId string) *PauseContinuation {
	row := kernelRow(store.DB, `SELECT request_id AS requestId,operation_id AS operationId
    FROM pause_continuations WHERE task_id=? AND node_id=? AND state='ready' ORDER BY rowid LIMIT 1`, taskId, nodeId)
	if row == nil {
		return nil
	}
	return &PauseContinuation{RequestId: kernelString(row["requestId"]), OperationId: kernelString(row["operationId"])}
}

func ConsumePauseContinuation(store *TaskStore, taskId, nodeId, operationId string) bool {
	changed := kernelChanges(store.DB, "UPDATE pause_continuations SET state='consumed',resumed_operation_id=? WHERE task_id=? AND node_id=? AND state='ready'", operationId, taskId, nodeId)
	if changed > 0 {
		store.Event(taskId, "pause.continuation_claimed", map[string]any{"operationId": operationId, "nodeId": nodeId})
	}
	return changed > 0
}
