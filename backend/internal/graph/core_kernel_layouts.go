package graph

func (k *KernelStore) ResetGraphLayout(taskID string) {
	g5Exec(k.Db, "DELETE FROM kernel_graph_layouts WHERE task_id=?", taskID)
}

func (k *KernelStore) KeepGraphLayout(taskID string, revisionVersion int, topology, layout string) {
	g5Exec(k.Db, "INSERT OR IGNORE INTO kernel_graph_layouts(task_id,revision_version,topology,layout) VALUES(?,?,?,?)",
		taskID, revisionVersion, topology, layout)
}

func (k *KernelStore) GraphLayoutSnapshot(taskID string, revision int) any {
	row := kernelRow(k.Db, "SELECT topology,layout FROM kernel_graph_layouts WHERE task_id=? AND revision_version<=? ORDER BY revision_version DESC LIMIT 1", taskID, revision)
	if row == nil {
		return nil
	}
	return map[string]any{"topology": kernelString(row["topology"]), "layout": parseJSON(kernelString(row["layout"]))}
}
