package graph

// GrantTaskCapability says a task may use one capability. The grant is kept
// if the task already has it.
func (s *TaskStore) GrantTaskCapability(taskID, grant string) {
	kernelExec(s.DB, "INSERT OR IGNORE INTO task_grants VALUES(?,?)", taskID, grant)
}
