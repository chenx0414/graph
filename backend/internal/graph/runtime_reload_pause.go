package graph

// A reload pauses the work it would otherwise wait for, and the next daemon
// continues it. See runtime_rsi_reload_pause.go for why the list is a file.

// PauseForReload interrupts every live turn and pauses its task, returning the
// task ids. Only dispatched operations count: a task that is idle is none of
// this reload's business, and one a person paused never appears here.
func (runtime *TaskRuntime) PauseForReload(store *TaskStore) []string {
	if runtime == nil || store == nil {
		return nil
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, row := range kernelRows(store.Db, `
		SELECT DISTINCT o.task_id AS task_id
		FROM operations o JOIN tasks t ON t.id=o.task_id
		WHERE o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid`) {
		taskID := kernelString(row["task_id"])
		if taskID == "" || seen[taskID] {
			continue
		}
		seen[taskID] = true
		for _, operation := range kernelRows(store.Db,
			`SELECT id FROM operations WHERE task_id=? AND state='dispatched' AND worker_active=1 ORDER BY rowid`, taskID) {
			runtime.execution.Interrupt(kernelString(operation["id"]), nil)
		}
		runtime.execution.StopActiveMasterTurns(taskID)
		store.SetTaskPaused(taskID, true)
		ids = append(ids, taskID)
	}
	return ids
}

// ResumeAfterReload puts back exactly the tasks this reload paused. A task that
// no longer exists is skipped instead of revived, and the resume is a normal
// dispatch: the Agent sees its own durable transcript and decides what to re-run.
func (runtime *TaskRuntime) ResumeAfterReload(store *TaskStore, ids []string) []string {
	if runtime == nil || store == nil {
		return nil
	}
	resumed := []string{}
	for _, id := range ids {
		if id == "" || kernelRow(store.Db, `SELECT id FROM tasks WHERE id=?`, id) == nil {
			continue
		}
		store.SetTaskPaused(id, false)
		resumed = append(resumed, id)
	}
	if len(resumed) > 0 && runtime.autoWake {
		runtime.execution.Kick()
	}
	return resumed
}
