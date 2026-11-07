package graph

func (s *TaskStore) RecordOperationIntent(id, taskID, nodeID string, instanceID *string, generation int, spec string, reserved int64, activationID string) {
	kernelExec(s.DB, `INSERT INTO operations(
        id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id
      ) VALUES(?,?,?,?,?,?,'intent',?,?)`,
		id, taskID, nodeID, instanceID, generation, spec, reserved, activationID)
}

func (s *TaskStore) TakeOperationReservation(operationID string, amount int64) bool {
	changes, _ := g5Exec(s.Db, "UPDATE operations SET reserved=? WHERE id=? AND state='intent' AND reserved=0", amount, operationID)
	return changes == 1
}

func (s *TaskStore) ClearOperationReservation(operationID string) {
	kernelExec(s.DB, "UPDATE operations SET reserved=0 WHERE id=?", operationID)
}

func (s *TaskStore) MarkOperationDispatched(operationID string) {
	kernelExec(s.DB, "UPDATE operations SET state='dispatched',worker_active=1,waiting_slot=0 WHERE id=?", operationID)
}

func (s *TaskStore) MarkOperationDispatchedAt(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET state='dispatched',worker_active=1,dispatched_at=COALESCE(dispatched_at,?) WHERE id=?", at, operationID)
}

func (s *TaskStore) MarkOperationUnsent(operationID, state string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET state=?,worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?) WHERE id=?", state, at, operationID)
}

func (s *TaskStore) MarkOperationUnknown(operationID string, active int) {
	kernelExec(s.DB, "UPDATE operations SET state='unknown',worker_active=? WHERE id=?", active, operationID)
}

func (s *TaskStore) RecordUnknownOperationResult(operationID, result string) {
	kernelExec(s.DB, "UPDATE operations SET state='unknown',worker_active=0,result=? WHERE id=?", result, operationID)
}

func (s *TaskStore) RecoverOperationAsUnknown(operationID string) {
	kernelExec(s.DB, "UPDATE operations SET state='unknown',worker_active=0,waiting_slot=0 WHERE id=?", operationID)
}

func (s *TaskStore) MarkOperationSettled(operationID, result string) {
	kernelExec(s.DB, "UPDATE operations SET state='settled',worker_active=0,result=? WHERE id=?", result, operationID)
}

func (s *TaskStore) AbandonOperation(operationID string, at int64) bool {
	changes, _ := g5Exec(s.DB, `UPDATE operations
 SET state='abandoned',worker_active=0,waiting_slot=0,reserved=0,settled_at=COALESCE(settled_at,?)
 WHERE id=? AND state='unknown' AND worker_active=0`, at, operationID)
	return changes == 1
}

func (s *TaskStore) MarkOperationSucceeded(operationID, result string, usage any, at int64) {
	kernelExec(s.DB, "UPDATE operations SET state='succeeded',worker_active=0,result=?,usage=?,settled_at=COALESCE(settled_at,?) WHERE id=?", result, usage, at, operationID)
}

func (s *TaskStore) SetOperationWorker(operationID string, active int) {
	kernelExec(s.DB, "UPDATE operations SET worker_active=? WHERE id=?", active, operationID)
}

func (s *TaskStore) ReleaseUnknownOperationWorkers() {
	kernelExec(s.DB, "UPDATE operations SET worker_active=0 WHERE state='unknown' AND worker_active=1")
}

func (s *TaskStore) HoldOperationSlot(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET waiting_slot=1,waiting_since=COALESCE(waiting_since,?) WHERE id=?", at, operationID)
}

func (s *TaskStore) CloseOperationSlot(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET waiting_slot=0,waiting_ms=waiting_ms + MAX(0,?-COALESCE(waiting_since,?)),waiting_since=NULL WHERE id=?", at, at, operationID)
}

func (s *TaskStore) ClearOperationSlot(operationID string) {
	kernelExec(s.DB, "UPDATE operations SET waiting_slot=0 WHERE id=?", operationID)
}

func (s *TaskStore) MarkOperationReplied(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE operations SET replied_at=COALESCE(replied_at,?) WHERE id=?", at, operationID)
}

func (s *TaskStore) RecordOperationSystemPrompt(operationID, text string, toolDeclarations any) {
	if _, err := s.DB.Exec("UPDATE operations SET system_prompt = ?, tool_declarations = ? WHERE id = ? AND system_prompt IS NULL", text, toolDeclarations, operationID); err != nil {
		panic(err)
	}
}
