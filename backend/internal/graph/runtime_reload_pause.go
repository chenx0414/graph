package graph

import "time"


func (runtime *TaskRuntime) PauseForReload(store *TaskStore, excludeTaskID string) []string {
	if runtime == nil || store == nil {
		return nil
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, row := range kernelRows(store.Db, `
		SELECT DISTINCT o.task_id AS task_id
		FROM operations o JOIN tasks t ON t.id=o.task_id
		WHERE o.state='dispatched' AND o.worker_active=1 AND COALESCE(t.paused,0)=0 ORDER BY o.rowid`) {
		taskID := kernelString(row["task_id"])
		if taskID == "" || taskID == excludeTaskID || seen[taskID] {
			continue
		}
		seen[taskID] = true
		interrupts := kernelRows(store.Db,
			`SELECT id FROM operations WHERE task_id=? AND state='dispatched' AND worker_active=1 ORDER BY rowid`, taskID)
		signalled := make(chan struct{})
		go func(taskID string, operations []map[string]any) {
			defer close(signalled)
			for _, operation := range operations {
				runtime.execution.Interrupt(kernelString(operation["id"]), nil)
			}
			runtime.execution.StopActiveMasterTurns(taskID)
		}(taskID, interrupts)
		select {
		case <-signalled:
		case <-time.After(2 * time.Second):
		}
		store.SetTaskPaused(taskID, true)
		ids = append(ids, taskID)
	}
	return ids
}

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
