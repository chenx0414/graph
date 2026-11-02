package graph

// RecordOperationIntent records the intent to run an operation, before any
// adapter can cause an external effect.
func (s *TaskStore) RecordOperationIntent(id, taskID, nodeID string, instanceID *string, generation int, spec string, reserved int64, activationID string) {
	kernelExec(s.DB, `INSERT INTO operations(
        id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id
      ) VALUES(?,?,?,?,?,?,'intent',?,?)`,
		id, taskID, nodeID, instanceID, generation, spec, reserved, activationID)
}

// TakeOperationReservation holds tokens against an operation, and reports
// whether it took them. Only an operation that has not been sent and holds
// no reservation yet can take one.
func (s *TaskStore) TakeOperationReservation(operationID string, amount int64) bool {
	changes, _ := g5Exec(s.Db, "UPDATE operations SET reserved=? WHERE id=? AND state='intent' AND reserved=0", amount, operationID)
	return changes == 1
}

// ClearOperationReservation gives the reserved tokens back.
func (s *TaskStore) ClearOperationReservation(operationID string) {
	kernelExec(s.DB, "UPDATE operations SET reserved=0 WHERE id=?", operationID)
}

// MarkOperationDispatched says the operation was sent.
func (s *TaskStore) MarkOperationDispatched(operationID string) {
	kernelExec(s.DB, "UPDATE operations SET state='dispatched',worker_active=1,waiting_slot=0 WHERE id=?", operationID)
}

// MarkOperationDispatchedAt says the operation was sent, and stamps the
// moment it was sent the first time it is sent.
func (s *TaskStore) MarkOperationDispatchedAt(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET state='dispatched',worker_active=1,dispatched_at=COALESCE(dispatched_at,?) WHERE id=?", at, operationID)
}

// MarkOperationUnsent says the operation never reached its adapter.
func (s *TaskStore) MarkOperationUnsent(operationID, state string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET state=?,worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?) WHERE id=?", state, at, operationID)
}

// MarkOperationUnknown says the outcome of the operation cannot be proven.
func (s *TaskStore) MarkOperationUnknown(operationID string, active int) {
	kernelExec(s.DB, "UPDATE operations SET state='unknown',worker_active=? WHERE id=?", active, operationID)
}

// RecordUnknownOperationResult says the outcome cannot be proven, and
// records what the operation produced.
func (s *TaskStore) RecordUnknownOperationResult(operationID, result string) {
	kernelExec(s.DB, "UPDATE operations SET state='unknown',worker_active=0,result=? WHERE id=?", result, operationID)
}

// RecoverOperationAsUnknown says an operation that was in flight when the
// daemon stopped cannot be proven, and is not waiting for a slot.
func (s *TaskStore) RecoverOperationAsUnknown(operationID string) {
	kernelExec(s.DB, "UPDATE operations SET state='unknown',worker_active=0,waiting_slot=0 WHERE id=?", operationID)
}

// MarkOperationSettled says the operation ended with a result.
func (s *TaskStore) MarkOperationSettled(operationID, result string) {
	kernelExec(s.DB, "UPDATE operations SET state='settled',worker_active=0,result=? WHERE id=?", result, operationID)
}

// AbandonOperation closes an operation whose outcome was never proven, after the
// problem that reported it was answered.
//
// The result, the usage and the dispatch time stay on the row: what ends is the
// hold, not the fact. Only an operation that already gave its worker back can be
// closed this way, and only while it is still "unknown", so a turn that comes
// back to life is never overwritten by a sweep. It reports whether this call is
// the one that closed the row.
func (s *TaskStore) AbandonOperation(operationID string, at int64) bool {
	changes, _ := g5Exec(s.DB, `UPDATE operations
 SET state='abandoned',worker_active=0,waiting_slot=0,reserved=0,settled_at=COALESCE(settled_at,?)
 WHERE id=? AND state='unknown' AND worker_active=0`, at, operationID)
	return changes == 1
}

// MarkOperationSucceeded says the operation succeeded, with what it
// produced and what it used.
func (s *TaskStore) MarkOperationSucceeded(operationID, result string, usage any, at int64) {
	kernelExec(s.DB, "UPDATE operations SET state='succeeded',worker_active=0,result=?,usage=?,settled_at=COALESCE(settled_at,?) WHERE id=?", result, usage, at, operationID)
}

// SetOperationWorker says whether a worker holds the operation.
func (s *TaskStore) SetOperationWorker(operationID string, active int) {
	kernelExec(s.DB, "UPDATE operations SET worker_active=? WHERE id=?", active, operationID)
}

// ReleaseUnknownOperationWorkers lets every operation whose outcome cannot
// be proven give its worker back.
func (s *TaskStore) ReleaseUnknownOperationWorkers() {
	kernelExec(s.DB, "UPDATE operations SET worker_active=0 WHERE state='unknown' AND worker_active=1")
}

// HoldOperationSlot says the operation is waiting for a slot.
func (s *TaskStore) HoldOperationSlot(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET waiting_slot=1,waiting_since=COALESCE(waiting_since,?) WHERE id=?", at, operationID)
}

// CloseOperationSlot says the slot is free again, and keeps the time the
// operation waited for it.
func (s *TaskStore) CloseOperationSlot(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET waiting_slot=0,waiting_ms=waiting_ms + MAX(0,?-COALESCE(waiting_since,?)),waiting_since=NULL WHERE id=?", at, at, operationID)
}

// ClearOperationSlot says the operation is not waiting for a slot any more,
// without keeping the time it waited.
func (s *TaskStore) ClearOperationSlot(operationID string) {
	kernelExec(s.DB, "UPDATE operations SET waiting_slot=0 WHERE id=?", operationID)
}

// MarkOperationReplied says the operation's answer reached the conversation.
func (s *TaskStore) MarkOperationReplied(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET replied_at=COALESCE(replied_at,?) WHERE id=?", at, operationID)
}

// RecordOperationSystemPrompt records the prompt and the tool table an
// operation ran with, but only for an operation that has none yet.
func (s *TaskStore) RecordOperationSystemPrompt(operationID, text string, toolDeclarations any) {
	if _, err := s.DB.Exec("UPDATE operations SET system_prompt = ?, tool_declarations = ? WHERE id = ? AND system_prompt IS NULL", text, toolDeclarations, operationID); err != nil {
		panic(err)
	}
}
