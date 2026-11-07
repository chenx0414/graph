package graph

import (
	"database/sql"

	"context"
)

func ReleaseTaskSlot(store *TaskStore, taskId string) *string {
	row := kernelRow(store.DB, "SELECT active_task FROM runtime")
	active, _ := row["active_task"].(string)
	if active != taskId {
		return nil
	}
	next := kernelRow(store.DB, "SELECT id FROM tasks WHERE phase='queued' ORDER BY created_seq LIMIT 1")
	if next == nil {
		store.ClearRuntimeActiveTask()
		return nil
	}
	id := next["id"].(string)
	store.SetRuntimeActiveTask(id)
	store.SetTaskPhase(id, "running")
	store.Event(id, "task.started", map[string]any{})
	return &id
}

type sqlDB interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}
