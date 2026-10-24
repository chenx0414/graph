package graph

// Applying a revision to the nodes and modules a graph already has.
//
// A node or module the revision adds is admitted instead of updated; one it
// removes is retired. Both directions are the store's business: the shape of
// the node and module tables is known here and nowhere else.

// ApplyNodeRevision puts a node on a new revision.
func (k *KernelStore) ApplyNodeRevision(taskID, nodeID string, revisionVersion int, spec string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET revision_version=?,spec=? WHERE task_id=? AND node_id=?", revisionVersion, spec, taskID, nodeID)
}

// ApplyModuleRevision puts a module on a new revision.
func (k *KernelStore) ApplyModuleRevision(taskID, moduleID string, revisionVersion int, moduleType, trigger string) {
	g5Exec(k.Db, "UPDATE kernel_modules SET revision_version=?,module_type=?,trigger=? WHERE task_id=? AND module_id=?", revisionVersion, moduleType, trigger, taskID, moduleID)
}
