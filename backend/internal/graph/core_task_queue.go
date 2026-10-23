package graph

import (
	"context"
	"database/sql"
)

// ReleaseTaskSlot releases a confirmed task's integration slot only after its
// work has ended. The caller's transaction keeps the terminal state and
// successor admission atomic. Management-created graphs that never owned this
// slot cannot release another task.
func ReleaseTaskSlot(store *TaskStore, taskId string) *string {
	row := kernelRow(store.DB, "SELECT active_task FROM runtime")
	active, _ := row["active_task"].(string)
	if active != taskId {
		return nil
	}
	next := kernelRow(store.DB, "SELECT id FROM tasks WHERE phase='queued' ORDER BY created_seq LIMIT 1")
	var nextID any
	if next != nil {
		nextID = next["id"]
	}
	kernelExec(store.DB, "UPDATE runtime SET active_task=?", nextID)
	if next == nil {
		return nil
	}
	id := next["id"].(string)
	store.SetTaskPhase(id, "running")
	store.Event(id, "task.started", map[string]any{})
	return &id
}

// sqlDB is the connection TaskStore exposes. *sql.DB and *sql.Conn both qualify.
type sqlDB interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}
