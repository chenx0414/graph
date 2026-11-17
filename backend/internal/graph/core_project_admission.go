package graph

func projectArchived(store *TaskStore, projectID string) bool {
	row := kernelRow(store.Db, "SELECT archived_at FROM projects WHERE id=?", projectID)
	return row != nil && row["archived_at"] != nil
}

func projectArchivedAt(store *TaskStore, projectID string) any {
	row := kernelRow(store.Db, "SELECT archived_at FROM projects WHERE id=?", projectID)
	if row == nil {
		return nil
	}
	return row["archived_at"]
}

func archivedProjectSet(store *TaskStore) map[string]bool {
	archived := map[string]bool{}
	for _, row := range kernelRows(store.Db, "SELECT id FROM projects WHERE archived_at IS NOT NULL") {
		archived[kernelString(row["id"])] = true
	}
	return archived
}

func archivedConversationSet(store *TaskStore) map[string]bool {
	archived := map[string]bool{}
	for _, row := range kernelRows(store.Db, "SELECT id FROM conversations WHERE archived_at IS NOT NULL") {
		archived[kernelString(row["id"])] = true
	}
	return archived
}

func requireProjectActive(store *TaskStore, projectID string) {
	if projectArchived(store, projectID) {
		Raise("project_archived", "The project is archived; restore it before starting work")
	}
}
