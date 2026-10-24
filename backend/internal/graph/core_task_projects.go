package graph

// The projects table is one project the daemon knows about: the root it
// lives in and the grants it has.
//
// It was written from three files with SQL of their own, so the shape of
// the table was known in three places. The task store owns it now.

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
