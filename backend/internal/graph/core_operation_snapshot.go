package graph

import (
	"encoding/json"
)

// OperationLifecycle owns the durable ordering around the adapter's work: intent,
// dispatch, reconciliation, settlement, blocking questions and rework.
type OperationLifecycle struct {
	generation int
	store      *TaskStore
	hooks      OperationLifecycleHooks
}

// NewOperationLifecycle binds the lifecycle to one task store.
func NewOperationLifecycle(store *TaskStore, hooks OperationLifecycleHooks) *OperationLifecycle {
	return &OperationLifecycle{store: store, hooks: hooks}
}

func (l *OperationLifecycle) transaction(action func() any) any {
	if l.store.IsTransaction() {
		return action()
	}
	return l.store.Transaction(action)
}

func (l *OperationLifecycle) operationRow(id string) map[string]any {
	row := kernelRow(l.store.Db, "SELECT * FROM operations WHERE id=?", id)
	if row == nil {
		Raise("not_found", "Operation not found")
	}
	return row
}

func (l *OperationLifecycle) nodeRow(taskId, nodeId string) map[string]any {
	row := kernelRow(l.store.Db, "SELECT * FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	if row == nil {
		Raise("not_found", "Unknown node "+nodeId)
	}
	return row
}

// Get reads one operation snapshot.
func (l *OperationLifecycle) Get(id string) *OperationSnapshot {
	row := kernelRow(l.store.Db, "SELECT * FROM operations WHERE id=?", id)
	if row == nil {
		return nil
	}
	return operationSnapshotOf(row)
}

func operationSnapshotOf(row map[string]any) *OperationSnapshot {
	snapshot := &OperationSnapshot{
		Id:           kernelString(row["id"]),
		Operation:    operationFrom(row),
		State:        kernelString(row["state"]),
		Reserved:     kernelInt(row["reserved"]),
		WorkerActive: kernelInt(row["worker_active"]) != 0,
	}
	if text := kernelString(row["result"]); text != "" {
		var result OperationResult
		if err := json.Unmarshal([]byte(text), &result); err != nil {
			panic(err)
		}
		snapshot.Result = &result
	}
	if row["dispatched_at"] != nil {
		value := kernelInt(row["dispatched_at"])
		snapshot.DispatchedAt = &value
	}
	if row["settled_at"] != nil {
		value := kernelInt(row["settled_at"])
		snapshot.SettledAt = &value
	}
	return snapshot
}

// Recover enters a new runtime generation and conservatively recovers prior work.
func (l *OperationLifecycle) Recover() int {
	return l.transaction(func() any {
		kernelExec(l.store.Db, "UPDATE runtime SET generation=generation+1")
		row := kernelRow(l.store.Db, "SELECT generation FROM runtime")
		generation := int(kernelInt(row["generation"]))
		l.generation = generation
		rows := kernelRows(l.store.Db, "SELECT * FROM operations WHERE state IN ('intent','dispatched')")
		for _, row := range rows {
			if kernelString(row["state"]) == "intent" {
				l.markNotSent(row, operationNotSentOptions{ResetNode: true, EventReason: operationLifecycleStringPtr("Recovered before dispatch")})
				ReleaseMessages(l.store, kernelString(row["id"]))
				continue
			}
			if l.restoreUnsentConversation(row) {
				continue
			}
			// Access grants cannot prove that an interrupted effect never happened.

			kernelExec(l.store.Db, "UPDATE operations SET state='unknown',worker_active=0,waiting_slot=0 WHERE id=?", kernelString(row["id"]))
			l.store.Event(kernelString(row["task_id"]), "operation.unknown", map[string]any{
				"operationId": kernelString(row["id"]),
				"reason":      "Recovered after restart with no live worker",
				"quiescent":   true,
			})
			l.Block(kernelString(row["task_id"]), kernelString(row["node_id"]), "recovery", map[string]any{
				"reason": "Dispatch was recorded; external outcome and worker liveness require reconciliation",
			}, operationLifecycleStringPtr(kernelString(row["id"])))
		}
		stranded := kernelRows(l.store.Db, `WITH candidates AS MATERIALIZED (
        SELECT DISTINCT o.* FROM operations o
        JOIN messages m ON m.operation_id=o.id AND m.role='user' AND m.state='delivered'
        JOIN tasks t ON t.id=o.task_id
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        WHERE o.state='not_sent' AND t.phase='chatting' AND n.status IN ('pending','failed')
          AND o.activation_id=n.activation_id)
        SELECT o.* FROM candidates o WHERE NOT EXISTS (SELECT 1 FROM operations later WHERE later.task_id=o.task_id AND later.node_id=o.node_id
            AND later.rowid>(SELECT rowid FROM operations WHERE id=o.id) AND (later.state!='not_sent' OR later.result IS NOT NULL))
          AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=o.task_id AND e.type='operation.recovery_bypassed'
            AND json_extract(e.data,'$.operationId')=o.id)`)
		for _, row := range stranded {
			l.restoreUnsentConversation(row)
		}
		kernelExec(l.store.Db, "UPDATE operations SET worker_active=0 WHERE state='unknown' AND worker_active=1")
		return generation
	}).(int)
}

func (l *OperationLifecycle) restoreUnsentConversation(row map[string]any) bool {
	taskId := kernelString(row["task_id"])
	task := l.store.Task(taskId)
	if task.Phase != "chatting" || task.Paused != 0 || row["result"] != nil {
		return false
	}
	node := l.nodeRow(taskId, kernelString(row["node_id"]))
	var spec NodeSpec
	if err := json.Unmarshal([]byte(kernelString(node["spec"])), &spec); err != nil {
		panic(err)
	}
	if spec.Role == nil || *spec.Role != "master" {
		return false
	}
	activationId := kernelString(node["activation_id"])
	if row["activation_id"] == nil || kernelString(row["activation_id"]) != activationId {
		return false
	}
	conversation := ConversationForTask(l.store, taskId)
	if conversation == nil || conversation.ArchivedAt != nil {
		return false
	}
	if kernelRow(l.store.Db, "SELECT 1 FROM questions WHERE task_id=? AND node_id=? AND status='open' LIMIT 1", taskId, kernelString(row["node_id"])) != nil {
		return false
	}
	if kernelRow(l.store.Db, "SELECT 1 FROM messages WHERE operation_id=? AND role='user' AND state='delivered' LIMIT 1", kernelString(row["id"])) == nil {
		return false
	}
	if l.hooks.CanReplayBeforeSend == nil || !l.hooks.CanReplayBeforeSend(operationFrom(row)) {
		return false
	}
	if kernelString(row["state"]) == "not_sent" {
		later := kernelRows(l.store.Db, `SELECT spec FROM operations WHERE task_id=? AND node_id=?
        AND rowid>(SELECT rowid FROM operations WHERE id=?) ORDER BY rowid`, taskId, kernelString(row["node_id"]), kernelString(row["id"]))
		for _, next := range later {
			var operation Operation
			if err := json.Unmarshal([]byte(kernelString(next["spec"])), &operation); err != nil {
				panic(err)
			}
			if l.hooks.CanReplayBeforeSend == nil || !l.hooks.CanReplayBeforeSend(operation) {
				return false
			}
		}
	}
	l.markNotSent(row, operationNotSentOptions{ResetNode: true, EventReason: operationLifecycleStringPtr("Recovered conversation before adapter session/send")})
	ReleaseMessages(l.store, kernelString(row["id"]))
	kernelExec(l.store.Db, "UPDATE activations SET state='pending' WHERE id=?", activationId)
	l.store.Event(taskId, "conversation.turn_requeued", map[string]any{"operationId": kernelString(row["id"]), "reason": "adapter_not_started"})
	return true
}
