package graph

// The one fact a graph's lifecycle row holds: whether something asked the
// graph to finish.

// RequestGraphCompletion says the graph is ready to finish.
func (k *KernelStore) RequestGraphCompletion(taskID string) {
	g5Exec(k.Db, "INSERT INTO kernel_lifecycle(task_id,completion_requested) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET completion_requested=1", taskID)
}

// ClearGraphCompletionRequest says the graph is not ready to finish after
// all.
func (k *KernelStore) ClearGraphCompletionRequest(taskID string) {
	g5Exec(k.Db, "UPDATE kernel_lifecycle SET completion_requested=0 WHERE task_id=?", taskID)
}
