package graph

// The kernel_graph_layouts table is the stored layout of one graph
// revision: the topology it has and the layout that was computed for it.
//
// It was written from two files with SQL of their own, one of them
// outside the store. The store owns it now.

// ResetGraphLayout forgets the stored layout, so the next read lays the
// graph out again.
func (k *KernelStore) ResetGraphLayout(taskID string) {
	g5Exec(k.Db, "DELETE FROM kernel_graph_layouts WHERE task_id=?", taskID)
}

// KeepGraphLayout stores the layout of one graph revision, and keeps the
// one already stored if there is one.
func (k *KernelStore) KeepGraphLayout(taskID string, revisionVersion int, topology, layout string) {
	g5Exec(k.Db, "INSERT OR IGNORE INTO kernel_graph_layouts(task_id,revision_version,topology,layout) VALUES(?,?,?,?)",
		taskID, revisionVersion, topology, layout)
}

// GraphLayoutSnapshot is the stored layout of one graph revision, or nil
// when it has none.
func (k *KernelStore) GraphLayoutSnapshot(taskID string, revision int) any {
	row := kernelRow(k.Db, "SELECT topology,layout FROM kernel_graph_layouts WHERE task_id=? AND revision_version<=? ORDER BY revision_version DESC LIMIT 1", taskID, revision)
	if row == nil {
		return nil
	}
	return map[string]any{"topology": kernelString(row["topology"]), "layout": parseJSON(kernelString(row["layout"]))}
}
