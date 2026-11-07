package graph

func (k *KernelStore) RequestGraphCompletion(taskID string) {
	g5Exec(k.Db, "INSERT INTO kernel_lifecycle(task_id,completion_requested) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET completion_requested=1", taskID)
}

func (k *KernelStore) ClearGraphCompletionRequest(taskID string) {
	g5Exec(k.Db, "UPDATE kernel_lifecycle SET completion_requested=0 WHERE task_id=?", taskID)
}
