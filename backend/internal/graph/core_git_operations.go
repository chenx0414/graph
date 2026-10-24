package graph

// The git tables: the operations the host runs against a repository, and
// the work copies those operations run in.
//
// They were written from five files with SQL of their own, so the shape of
// both tables was known in five places. This file owns them.

// RecordGitOperation records one git operation and the spec it runs.
func RecordGitOperation(store *TaskStore, id, taskID, kind, state, spec string) {
	kernelExec(store.Db, "INSERT INTO git_ops(id,task_id,kind,state,spec,result) VALUES(?,?,?,?,?,NULL)",
		id, taskID, kind, state, spec)
}

// SettleGitOperation records how one git operation ended.
func SettleGitOperation(store *TaskStore, id, state string, result any) {
	kernelExec(store.Db, "UPDATE git_ops SET state=?,result=? WHERE id=?", state, result, id)
}

// SettleGitDeliveries says every delivery of one task reached its target.
func SettleGitDeliveries(store *TaskStore, taskID string) {
	kernelExec(store.Db, "UPDATE git_ops SET state='succeeded' WHERE task_id=? AND kind='deliver' AND state IN ('intent','dispatched')", taskID)
}

// ReplaceIntegrationWorktree records the work copy a task integrates in,
// replacing the one recorded before it.
func ReplaceIntegrationWorktree(store *TaskStore, taskID, path, branch string) {
	kernelExec(store.Db, "INSERT OR REPLACE INTO worktrees(instance_id,task_id,node_id,path,branch) VALUES(?,?,?,?,?)",
		"integration:"+taskID, taskID, "integration", path, branch)
}

// AddIntegrationWorktree records the work copy a task integrates in.
func AddIntegrationWorktree(store *TaskStore, taskID, path, branch string) {
	kernelExec(store.Db, "INSERT INTO worktrees(instance_id,task_id,node_id,path,branch) VALUES(?,?,?,?,?)",
		"integration:"+taskID, taskID, "integration", path, branch)
}

// KeepNodeWorktree records the work copy of one node, and keeps the one
// already recorded if there is one.
func KeepNodeWorktree(store *TaskStore, instanceID, taskID, nodeID, path, branch string) {
	kernelExec(store.Db, "INSERT OR IGNORE INTO worktrees(instance_id,task_id,node_id,path,branch) VALUES(?,?,?,?,?)",
		instanceID, taskID, nodeID, path, branch)
}

// ReleaseWorktrees forgets the work copies of one task.
func ReleaseWorktrees(store *TaskStore, taskID string) {
	kernelExec(store.Db, "DELETE FROM worktrees WHERE task_id=?", taskID)
}
