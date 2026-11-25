package graph

// graph:table-writes-exempt: the test seeds the one task row the sweep counts events for

import (
	"path/filepath"
	"testing"
)

// Retention deletes rows on the store's single shared connection, so it has to obey the
// store's transaction discipline. Entering it from inside a transaction used to self-deadlock
// on txMu, because Transaction locks that mutex before it checks whether a transaction is
// already open; running the sweep concurrently let its COMMIT land inside the store's
// transaction, which the store reports as "database is locked (5) (SQLITE_BUSY)" from an
// unrelated caller. Measured 2026-11-21: it surfaced in ./internal/graph about once in six
// runs, with a stack naming WakeForNodeSettled instead of the sweep.
func TestRetentionJoinsTheTransactionItIsCalledFrom(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "graph.sqlite"))
	t.Cleanup(store.Close)
	store.RegisterProject("p", t.TempDir(), "[]")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t1','p','probe',1)")

	completed := false
	store.Transaction(func(tx *TaskStore) any {
		tx.ApplyRetention(RetentionOptions{Now: NowMillis()})
		completed = true
		return nil
	})
	if !completed {
		t.Fatal("the sweep must return inside the caller's transaction")
	}
	store.Transaction(func(tx *TaskStore) any {
		tx.Event("t1", "after", map[string]any{"n": 1})
		return nil
	})
	if row := kernelRow(store.DB, "SELECT count(*) AS n FROM events WHERE task_id='t1' AND type='after'"); kernelInt(row["n"]) != 1 {
		t.Fatalf("the store must still accept a transaction after the sweep, got %d row(s)", kernelInt(row["n"]))
	}
}
