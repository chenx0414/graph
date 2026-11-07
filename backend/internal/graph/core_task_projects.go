package graph

func (s *TaskStore) RegisterProject(id, root, grants string) {
	kernelExec(s.DB, "INSERT INTO projects(id,root,grants) VALUES(?,?,?)", id, root, grants)
}

func (s *TaskStore) KeepProject(id, root, grants string) {
	kernelExec(s.DB, "INSERT OR IGNORE INTO projects(id,root,grants) VALUES(?,?,?)", id, root, grants)
}

func (s *TaskStore) MoveProjectRoot(id, root string) {
	kernelExec(s.DB, "UPDATE projects SET root=? WHERE id=?", root, id)
}

func (s *TaskStore) ArchiveProject(projectID string, at int64) {
	kernelExec(s.DB, "UPDATE projects SET archived_at=COALESCE(archived_at,?) WHERE id=?", at, projectID)
}

func (s *TaskStore) RestoreProject(projectID string) {
	kernelExec(s.DB, "UPDATE projects SET archived_at=NULL WHERE id=?", projectID)
}
