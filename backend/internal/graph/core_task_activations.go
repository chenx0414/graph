package graph

// The activations table is the turns of the v1 node path: one row per turn
// of one node, with the state that turn is in and the round it is on.
//
// It was written from eight files with SQL of their own, so the shape of
// the table was known in eight places. The task store owns it now.

// CreateActivation opens a turn for one node and points the node at it.
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

// PrepareActivation says a turn is being set up, with the inputs it will
// run with.
func (s *TaskStore) PrepareActivation(activationID, inputVersions string) {
	kernelExec(s.DB, "UPDATE activations SET input_versions=?,state='preparing' WHERE id=?", inputVersions, activationID)
}

// RunActivation says a turn is running.
func (s *TaskStore) RunActivation(activationID string) {
	kernelExec(s.DB, "UPDATE activations SET state='running' WHERE id=?", activationID)
}

// BlockActivation says a turn is blocked.
func (s *TaskStore) BlockActivation(activationID string) {
	kernelExec(s.DB, "UPDATE activations SET state='blocked' WHERE id=?", activationID)
}

// RetryActivation says a turn will be tried again, on the next round.
func (s *TaskStore) RetryActivation(activationID string) {
	kernelExec(s.DB, "UPDATE activations SET state='pending',round=round+1 WHERE id=?", activationID)
}

// ResetActivation says a turn is waiting again.
func (s *TaskStore) ResetActivation(activationID string) {
	kernelExec(s.DB, "UPDATE activations SET state='pending' WHERE id=?", activationID)
}

// ResetNodeActivation says the turn of one node is waiting again.
func (s *TaskStore) ResetNodeActivation(taskID, nodeID string) {
	kernelExec(s.DB, "UPDATE activations SET state='pending' WHERE id=(SELECT activation_id FROM nodes WHERE task_id=? AND id=?)", taskID, nodeID)
}

// SettleActivation says a turn ended, and leaves it in the state its node
// reached.
func (s *TaskStore) SettleActivation(activationID, taskID, nodeID string) {
	kernelExec(s.DB, "UPDATE activations SET state=(SELECT status FROM nodes WHERE task_id=? AND id=?) WHERE id=?", taskID, nodeID, activationID)
}
