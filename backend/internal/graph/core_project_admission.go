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

func requireProjectActive(store *TaskStore, projectID string) {
	if projectArchived(store, projectID) {
		Raise("project_archived", "The project is archived; restore it before starting work")
	}
}
