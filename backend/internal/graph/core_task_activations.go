package graph

func (s *TaskStore) CreateActivation(taskID, nodeID string, graphVersion int, round ...int) string {
	which := 1
	if len(round) > 0 {
		which = round[0]
	}
	id := graphUUID()
	kernelExec(s.DB, "INSERT INTO activations(id,task_id,node_id,graph_version,round,state,input_versions) VALUES(?,?,?,?,?,'pending','{}')",
		id, taskID, nodeID, graphVersion, which)
	s.SetNodeActivation(taskID, nodeID, id)
	return id
}

func (s *TaskStore) PrepareActivation(activationID, inputVersions string) {
	kernelExec(s.DB, "UPDATE activations SET input_versions=?,state='preparing' WHERE id=?", inputVersions, activationID)
}

func (s *TaskStore) RunActivation(activationID string) {
	kernelExec(s.DB, "UPDATE activations SET state='running' WHERE id=?", activationID)
}

func (s *TaskStore) BlockActivation(activationID string) {
	kernelExec(s.DB, "UPDATE activations SET state='blocked' WHERE id=?", activationID)
}

func (s *TaskStore) RetryActivation(activationID string) {
	kernelExec(s.DB, "UPDATE activations SET state='pending',round=round+1 WHERE id=?", activationID)
}

func (s *TaskStore) ResetActivation(activationID string) {
	kernelExec(s.DB, "UPDATE activations SET state='pending' WHERE id=?", activationID)
}

func (s *TaskStore) ResetNodeActivation(taskID, nodeID string) {
	kernelExec(s.DB, "UPDATE activations SET state='pending' WHERE id=(SELECT activation_id FROM nodes WHERE task_id=? AND id=?)", taskID, nodeID)
}

func (s *TaskStore) SettleActivation(activationID, taskID, nodeID string) {
	kernelExec(s.DB, "UPDATE activations SET state=(SELECT status FROM nodes WHERE task_id=? AND id=?) WHERE id=?", taskID, nodeID, activationID)
}
