package graph

// RegisterProject records one project.
func (s *TaskStore) RegisterProject(id, root, grants string) {
	kernelExec(s.DB, "INSERT INTO projects(id,root,grants) VALUES(?,?,?)", id, root, grants)
}

// KeepProject records one project, and keeps the one already recorded if
// there is one.
func (s *TaskStore) KeepProject(id, root, grants string) {
	kernelExec(s.DB, "INSERT OR IGNORE INTO projects(id,root,grants) VALUES(?,?,?)", id, root, grants)
}

// MoveProjectRoot says where a project lives now.
func (s *TaskStore) MoveProjectRoot(id, root string) {
	kernelExec(s.DB, "UPDATE projects SET root=? WHERE id=?", root, id)
}

func (s *TaskStore) ArchiveProject(projectID string, at int64) {
	kernelExec(s.DB, "UPDATE projects SET archived_at=COALESCE(archived_at,?) WHERE id=?", at, projectID)
}

func (s *TaskStore) RestoreProject(projectID string) {
	kernelExec(s.DB, "UPDATE projects SET archived_at=NULL WHERE id=?", projectID)
}
