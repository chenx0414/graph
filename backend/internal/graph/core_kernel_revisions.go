package graph

func (k *KernelStore) ApplyNodeRevision(taskID, nodeID string, revisionVersion int, spec string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET revision_version=?,spec=? WHERE task_id=? AND node_id=?", revisionVersion, spec, taskID, nodeID)
}

func (k *KernelStore) ApplyModuleRevision(taskID, moduleID string, revisionVersion int, moduleType, trigger string) {
	g5Exec(k.Db, "UPDATE kernel_modules SET revision_version=?,module_type=?,trigger=? WHERE task_id=? AND module_id=?", revisionVersion, moduleType, trigger, taskID, moduleID)
}
