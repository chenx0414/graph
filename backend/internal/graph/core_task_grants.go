package graph

func (s *TaskStore) GrantTaskCapability(taskID, grant string) {
	kernelExec(s.DB, "INSERT OR IGNORE INTO task_grants VALUES(?,?)", taskID, grant)
}
