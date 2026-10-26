package graph

// SetRuntimeActiveTask says which task is the active one.
func (s *TaskStore) SetRuntimeActiveTask(taskID string) {
	kernelExec(s.DB, "UPDATE runtime SET active_task=?", taskID)
}

// ClearRuntimeActiveTask says there is no active task.
func (s *TaskStore) ClearRuntimeActiveTask() {
	kernelExec(s.DB, "UPDATE runtime SET active_task=NULL")
}

// BumpRuntimeGeneration moves the runtime on to the next generation, so
// work from the previous one is recognised as stale.
func (s *TaskStore) BumpRuntimeGeneration() {
	kernelExec(s.DB, "UPDATE runtime SET generation=generation+1")
}
