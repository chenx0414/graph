// graph:table-writes-exempt: the test only reads the count it seeded
package graph

import (
	"os"
	"path/filepath"
	"testing"
)

// activeOperationsOn seeds a store and returns the count the reload gate reads.
func activeOperationsOn(t *testing.T, seed func(*TaskStore)) int {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "tasks.sqlite")
	db, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	store := NewTaskStore(db, path)
	defer store.Close()
	runtime := &TaskRuntime{store: store}
	seed(store)
	return runtime.ActiveOperationCount()
}

func seedTask(store *TaskStore) {
	kernelExec(store.Db, `INSERT OR IGNORE INTO projects(id, root, grants) VALUES('p1', ?, '[]')`, os.TempDir())
	kernelExec(store.Db, `INSERT OR IGNORE INTO tasks(id, project_id, request, requirement_version, latest_proposal, phase, paused, created_seq, graph_version)
        VALUES('t1','p1','e2e',1,0,'running',0,1,1)`)
	kernelExec(store.Db, `INSERT OR IGNORE INTO nodes(task_id, id, spec) VALUES('t1','n1','{}')`)
}

// The real probe lost a turn in the gap between two tool calls: the operation was
// dispatched but no worker was active at that instant, so a count keyed on
// worker_active read zero and the daemon was replaced under the running turn.
//
// An operation that has not settled is work in flight, whatever its worker is
// doing this millisecond.
func TestADispatchedOperationBetweenToolCallsIsStillActive(t *testing.T) {
	count := activeOperationsOn(t, func(store *TaskStore) {
		seedTask(store)
		kernelExec(store.Db, `INSERT INTO operations(id, task_id, node_id, generation, spec, state, reserved, worker_active, waiting_slot, settled_at)
            VALUES('op1','t1','n1',1,'{}','dispatched',1,0,0,NULL)`)
	})
	if count != 1 {
		t.Fatalf("a dispatched operation with no active worker is still in flight, got %d", count)
	}
}

// Every unsettled state counts, so no window between them is a false idle.
func TestEveryUnsettledStateIsActive(t *testing.T) {
	for _, state := range []string{"intent", "prepared", "dispatched", "running"} {
		count := activeOperationsOn(t, func(store *TaskStore) {
			seedTask(store)
			kernelExec(store.Db, `INSERT INTO operations(id, task_id, node_id, generation, spec, state, reserved, worker_active, waiting_slot, settled_at)
                VALUES('op1','t1','n1',1,'{}','`+state+`',1,0,0,NULL)`)
		})
		if count != 1 {
			t.Errorf("state %q must count as in flight, got %d", state, count)
		}
	}
}

// A settled operation is finished work: the gate may replace the daemon.
func TestSettledOperationsAreIdle(t *testing.T) {
	count := activeOperationsOn(t, func(store *TaskStore) {
		seedTask(store)
		kernelExec(store.Db, `INSERT INTO operations(id, task_id, node_id, generation, spec, state, reserved, worker_active, waiting_slot, settled_at)
            VALUES('op1','t1','n1',1,'{}','succeeded',0,0,0,123)`)
	})
	if count != 0 {
		t.Fatalf("a settled operation is not work in flight, got %d", count)
	}
}

// A failed operation that never wrote settled_at is still an open row: the run that
// failed may be about to be retried, and replacing the daemon loses the retry.
func TestAnUnsettledFailureIsStillActive(t *testing.T) {
	count := activeOperationsOn(t, func(store *TaskStore) {
		seedTask(store)
		kernelExec(store.Db, `INSERT INTO operations(id, task_id, node_id, generation, spec, state, reserved, worker_active, waiting_slot, settled_at)
            VALUES('op1','t1','n1',1,'{}','failed',0,0,0,NULL)`)
	})
	if count != 1 {
		t.Fatalf("an operation with no settled_at is still open, got %d", count)
	}
}
