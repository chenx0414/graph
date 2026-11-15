// graph:table-writes-exempt: a test seeds the events it retains
package graph

import (
	"path/filepath"
	"testing"
)

func TestTheMaintenanceLoopAppliesRetention(t *testing.T) {
	t.Setenv("GRAPH_STATE_SWEEP_INTERVAL_MS", "0")
	t.Setenv("GRAPH_STATE_RETENTION_MIN_AGE_MS", "0")
	t.Setenv("GRAPH_STATE_RETENTION_KEEP_EVENTS", "1")
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	defer store.Close()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/retention-fixture','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','r',1)")
	kernelExec(store.DB, "INSERT INTO events(task_id,type,data,timestamp) VALUES('t','probe','{}',1)")
	kernelExec(store.DB, "INSERT INTO events(task_id,type,data,timestamp) VALUES('t','probe','{}',2)")
	execution := &Execution{store: store}
	execution.sweepState()
	if remaining := kernelInt(kernelRow(store.DB, "SELECT COUNT(*) AS count FROM events WHERE task_id='t'")["count"]); remaining != 1 {
		t.Fatalf("retention keeps the configured newest event and removes the older one, got %d", remaining)
	}
}
