package graph

func (s *TaskStore) SetRuntimeActiveTask(taskID string) {
	kernelExec(s.DB, "UPDATE runtime SET active_task=?", taskID)
}

func (s *TaskStore) ClearRuntimeActiveTask() {
	kernelExec(s.DB, "UPDATE runtime SET active_task=NULL")
}

func (s *TaskStore) BumpRuntimeGeneration() {
	kernelExec(s.DB, "UPDATE runtime SET generation=generation+1")
}
