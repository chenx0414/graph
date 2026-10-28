package graph

func projectArchived(store *TaskStore, projectID string) bool {
	row := kernelRow(store.Db, "SELECT archived_at FROM projects WHERE id=?", projectID)
	return row != nil && row["archived_at"] != nil
}

func requireProjectActive(store *TaskStore, projectID string) {
	if projectArchived(store, projectID) {
		Raise("project_archived", "The project is archived; restore it before starting work")
	}
}
