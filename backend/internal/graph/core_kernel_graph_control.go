package graph

// The control surface of a graph: what a caller may do to a running graph
// without touching the kernel tables itself.
//
// Every method here is one statement. A statement is atomic by itself, so
// these can be called from inside a transaction the caller already holds -
// which is exactly where the graph's controls are applied.

// CancelModuleOperation says an operation will not run.
func (k *KernelStore) CancelModuleOperation(operationID string) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET state='cancelled' WHERE id=?", operationID)
}

// RouteGraphTransitions says every judgment of a graph has been routed.
func (k *KernelStore) RouteGraphTransitions(taskID string) {
	g5Exec(k.Db, "UPDATE kernel_transition_outbox SET routed=1 WHERE transition_id IN (SELECT id FROM kernel_module_transitions WHERE task_id=?)", taskID)
}

// UnblockNode returns a blocked node to idle, so it can pick work up again.
func (k *KernelStore) UnblockNode(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status='blocked'", taskID, nodeID)
}

// ReleaseNode returns a node that cannot run to idle, so it can pick work up
// again after the queue item it waited for was retried, skipped or cancelled.
func (k *KernelStore) ReleaseNode(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status IN ('blocked','failed')", taskID, nodeID)
}

// RetryQueueItem puts a queue item back, so it runs once more.
func (k *KernelStore) RetryQueueItem(taskID string, seq int64, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='queued',reason=?,generation=generation+1 WHERE task_id=? AND seq=?", reason, taskID, seq)
}

// SettleQueueItem ends a queue item without running it again.
func (k *KernelStore) SettleQueueItem(taskID string, seq int64, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='done',reason=? WHERE task_id=? AND seq=?", reason, taskID, seq)
}

// CancelQueuedWork ends every queue item that has not started yet.
func (k *KernelStore) CancelQueuedWork(taskID, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='done',reason=? WHERE task_id=? AND state='queued'", reason, taskID)
}

// UnpauseNodeState lets a node's queue run again.
func (k *KernelStore) UnpauseNodeState(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_node_state SET paused=0 WHERE task_id=? AND node_id=?", taskID, nodeID)
}
