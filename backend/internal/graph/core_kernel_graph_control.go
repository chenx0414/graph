package graph

func (k *KernelStore) CancelModuleOperation(operationID string) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET state='cancelled' WHERE id=?", operationID)
}

func (k *KernelStore) RouteGraphTransitions(taskID string) {
	g5Exec(k.Db, "UPDATE kernel_transition_outbox SET routed=1 WHERE transition_id IN (SELECT id FROM kernel_module_transitions WHERE task_id=?)", taskID)
}

func (k *KernelStore) UnblockNode(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status='blocked'", taskID, nodeID)
}

func (k *KernelStore) ReleaseNode(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status IN ('blocked','failed')", taskID, nodeID)
}

func (k *KernelStore) RetryQueueItem(taskID string, seq int64, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='queued',reason=?,generation=generation+1 WHERE task_id=? AND seq=?", reason, taskID, seq)
}

func (k *KernelStore) SettleQueueItem(taskID string, seq int64, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='done',reason=? WHERE task_id=? AND seq=?", reason, taskID, seq)
}

func (k *KernelStore) CancelQueuedWork(taskID, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='done',reason=? WHERE task_id=? AND state='queued'", reason, taskID)
}

func (k *KernelStore) UnpauseNodeState(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_node_state SET paused=0 WHERE task_id=? AND node_id=?", taskID, nodeID)
}
