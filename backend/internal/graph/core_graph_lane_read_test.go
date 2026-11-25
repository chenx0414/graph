// graph:table-writes-exempt: the test seeds the queue rows the lane reads
package graph

import (
	"path/filepath"
	"testing"
	"time"
)

// A queue read must not hold the transaction lock: a transaction body that reads the queue then waits on its own lock.
func TestReadingTheQueueDoesNotBlockATransaction(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "lane-read.sqlite"))
	defer store.Close()
	store.RegisterProject("p", t.TempDir(), "[]")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t1','p','probe',1,'working')")
	store.Transaction(func(tx *TaskStore) any {
		tx.Event("t1", "seed", map[string]any{"n": 1})
		return nil
	})

	lane := &GraphLane{options: GraphLaneOptions{Kernel: NewKernelStore(store)}}

	// The production stack is a transaction body that reads the queue: the transaction holds the
	// lock, and the read reached for the same lock again on the same goroutine.
	done := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- nil
			}
		}()
		store.Transaction(func(tx *TaskStore) any {
			tx.Event("t1", "while-reading", map[string]any{"n": 2})
			lane.Runnable()
			return nil
		})
		done <- nil
	}()

	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatalf("reading the queue inside a transaction deadlocked on the transaction's own lock")
	}

	if got := kernelInt(kernelRow(store.DB, "SELECT COUNT(*) AS c FROM events WHERE type='while-reading'")["c"]); got != 1 {
		t.Fatalf("the transaction's row did not survive: %d", got)
	}
}
