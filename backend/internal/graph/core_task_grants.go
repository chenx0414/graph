package graph

// The task_grants table is one capability a task was granted.
//
// It was written from two files with SQL of their own, so the shape of the
// table was known in two places. The task store owns it now.

// GrantTaskCapability says a task may use one capability. The grant is kept
// if the task already has it.
func (s *TaskStore) GrantTaskCapability(taskID, grant string) {
	kernelExec(s.DB, "INSERT OR IGNORE INTO task_grants VALUES(?,?)", taskID, grant)
}
