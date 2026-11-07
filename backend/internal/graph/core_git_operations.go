package graph

func RecordGitOperation(store *TaskStore, id, taskID, kind, state, spec string) {
	kernelExec(store.Db, "INSERT INTO git_ops(id,task_id,kind,state,spec,result) VALUES(?,?,?,?,?,NULL)",
		id, taskID, kind, state, spec)
}

func SettleGitOperation(store *TaskStore, id, state string, result any) {
	kernelExec(store.Db, "UPDATE git_ops SET state=?,result=? WHERE id=?", state, result, id)
}

func SettleGitDeliveries(store *TaskStore, taskID string) {
	kernelExec(store.Db, "UPDATE git_ops SET state='succeeded' WHERE task_id=? AND kind='deliver' AND state IN ('intent','dispatched')", taskID)
}

func ReplaceIntegrationWorktree(store *TaskStore, taskID, path, branch string) {
	kernelExec(store.Db, "INSERT OR REPLACE INTO worktrees(instance_id,task_id,node_id,path,branch) VALUES(?,?,?,?,?)",
		"integration:"+taskID, taskID, "integration", path, branch)
}

func AddIntegrationWorktree(store *TaskStore, taskID, path, branch string) {
	kernelExec(store.Db, "INSERT INTO worktrees(instance_id,task_id,node_id,path,branch) VALUES(?,?,?,?,?)",
		"integration:"+taskID, taskID, "integration", path, branch)
}

func KeepNodeWorktree(store *TaskStore, instanceID, taskID, nodeID, path, branch string) {
	kernelExec(store.Db, "INSERT OR IGNORE INTO worktrees(instance_id,task_id,node_id,path,branch) VALUES(?,?,?,?,?)",
		instanceID, taskID, nodeID, path, branch)
}

func ReleaseWorktrees(store *TaskStore, taskID string) {
	kernelExec(store.Db, "DELETE FROM worktrees WHERE task_id=?", taskID)
}
