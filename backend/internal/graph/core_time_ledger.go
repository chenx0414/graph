package graph

import "fmt"

// SetNativeExecutionWaiting opens or closes the credential/slot wait on one running execution.
func SetNativeExecutionWaiting(store *TaskStore, executionID string, waiting bool, now ...int64) {
	at := NowMillis()
	if len(now) > 0 {
		at = now[0]
	}
	update := func() {
		var changes int64
		if waiting {
			changes, _ = g5Exec(store.Db, `UPDATE kernel_executions SET
          run_ms=run_ms+CASE WHEN run_since IS NULL THEN 0 ELSE MAX(0,?-run_since) END,
          run_since=NULL,waiting_since=?,waiting_slot=1
          WHERE id=? AND state='running' AND waiting_slot=0`, at, at, executionID)
		} else {
			changes, _ = g5Exec(store.Db, `UPDATE kernel_executions SET
          waiting_ms=waiting_ms+CASE WHEN waiting_since IS NULL THEN 0 ELSE MAX(0,?-waiting_since) END,
          waiting_since=NULL,run_since=?,waiting_slot=0
          WHERE id=? AND state='running' AND waiting_slot=1`, at, at, executionID)
		}
		if changes != 0 {
			row, _ := g5One(store.Db, "SELECT task_id,node_id FROM kernel_executions WHERE id=?", executionID)
			store.Event(g5Str(row["task_id"]), "graph.execution.waiting", map[string]any{
				"executionId": executionID, "nodeId": g5Str(row["node_id"]), "waiting": waiting,
			})
		}
	}
	if store.IsTransaction() {
		update()
		return
	}
	store.Transaction(update)
}

// CloseNativeExecutionTiming ends a measured segment at its terminal boundary.
func CloseNativeExecutionTiming(store *TaskStore, executionID string, now ...int64) {
	at := NowMillis()
	if len(now) > 0 {
		at = now[0]
	}
	g5Exec(store.Db, `UPDATE kernel_executions SET
    run_ms=run_ms+CASE WHEN run_since IS NULL THEN 0 ELSE MAX(0,?-run_since) END,
    waiting_ms=waiting_ms+CASE WHEN waiting_since IS NULL THEN 0 ELSE MAX(0,?-waiting_since) END,
    run_since=NULL,waiting_since=NULL,waiting_slot=0 WHERE id=?`, at, at, executionID)
}

const timeLedgerTerminal = "('succeeded','skipped','retired','failed')"

func OpenPause(store *TaskStore, taskID string, now ...int64) {
	at := ledgerNow(now)
	SetNativePause(store, taskID, true, "", at)
	g5Exec(store.Db, fmt.Sprintf("UPDATE nodes SET pause_since=? WHERE task_id=? AND pause_since IS NULL AND status NOT IN %s", timeLedgerTerminal), at, taskID)
}

func ClosePause(store *TaskStore, taskID string, now ...int64) {
	at := ledgerNow(now)
	SetNativePause(store, taskID, false, "", at)
	g5Exec(store.Db, `UPDATE nodes SET pause_ms=COALESCE(pause_ms,0)+(?-pause_since), pause_since=NULL
    WHERE task_id=? AND pause_since IS NOT NULL AND ? >= pause_since`, at, taskID, at)
}

func OpenUserWait(store *TaskStore, taskID, nodeID string, now ...int64) {
	g5Exec(store.Db, "UPDATE nodes SET user_wait_since=? WHERE task_id=? AND id=? AND user_wait_since IS NULL", ledgerNow(now), taskID, nodeID)
}

func CloseUserWait(store *TaskStore, taskID, nodeID string, now ...int64) {
	at := ledgerNow(now)
	g5Exec(store.Db, `UPDATE nodes SET user_wait_ms=COALESCE(user_wait_ms,0)+(?-user_wait_since), user_wait_since=NULL
    WHERE task_id=? AND id=? AND user_wait_since IS NOT NULL AND ? >= user_wait_since`, at, taskID, nodeID, at)
}

func CloseUserWaitForOperation(store *TaskStore, operationID string, now ...int64) {
	operation, ok := g5One(store.Db, "SELECT task_id,node_id FROM operations WHERE id=?", operationID)
	if ok {
		CloseUserWait(store, g5Str(operation["task_id"]), g5Str(operation["node_id"]), ledgerNow(now))
	}
}

// NodeTimeLedger is one node's pause and user-wait totals. Nil means never recorded.
type NodeTimeLedger struct {
	PauseMs    *int64 `json:"pauseMs,omitempty"`
	UserWaitMs *int64 `json:"userWaitMs,omitempty"`
}

func NodeTimeLedgerOf(store *TaskStore, taskID, nodeID string, now ...int64) NodeTimeLedger {
	at := ledgerNow(now)
	row, ok := g5One(store.Db, "SELECT status,pause_ms,pause_since,user_wait_ms,user_wait_since FROM nodes WHERE task_id=? AND id=?", taskID, nodeID)
	if !ok {
		return NodeTimeLedger{}
	}
	terminal := map[string]bool{"succeeded": true, "skipped": true, "retired": true, "failed": true}[g5Str(row["status"])]
	live := func(since any) int64 {
		if since == nil || terminal {
			return 0
		}
		delta := at - g5Int(since)
		if delta < 0 {
			return 0
		}
		return delta
	}
	out := NodeTimeLedger{}
	if row["pause_ms"] != nil || row["pause_since"] != nil {
		total := int64(0)
		if row["pause_ms"] != nil {
			total = g5Int(row["pause_ms"])
		}
		total += live(row["pause_since"])
		out.PauseMs = &total
	}
	if row["user_wait_ms"] != nil || row["user_wait_since"] != nil {
		total := int64(0)
		if row["user_wait_ms"] != nil {
			total = g5Int(row["user_wait_ms"])
		}
		total += live(row["user_wait_since"])
		out.UserWaitMs = &total
	}
	return out
}

// SetNativePause shares one elapsed interval for graph and node pause controls.
// nodeID empty means the whole graph. now is optional and defaults to NowMillis when 0 is not passed;
// callers that need an explicit timestamp pass it as the last argument.
func SetNativePause(store *TaskStore, taskID string, paused bool, nodeID string, now int64) {
	if _, ok := g5One(store.Db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_nodes'"); !ok {
		return
	}
	phase := store.Task(taskID).Phase
	if paused && (phase == "completed" || phase == "stopping" || phase == "stopped") {
		return
	}
	if now == 0 {
		now = NowMillis()
	}
	target := "task_id=?"
	args := []any{taskID}
	if nodeID != "" {
		target = "task_id=? AND node_id=?"
		args = []any{taskID, nodeID}
	}
	column := "graph_paused"
	if nodeID != "" {
		column = "node_paused"
	}
	flag := 0
	if paused {
		flag = 1
	}
	g5Exec(store.Db, fmt.Sprintf("UPDATE kernel_nodes SET %s=? WHERE %s AND status!='retired'", column, target), append([]any{flag}, args...)...)
	g5Exec(store.Db, fmt.Sprintf(`UPDATE kernel_nodes SET pause_since=? WHERE %s AND status!='retired'
    AND (graph_paused=1 OR node_paused=1) AND pause_since IS NULL`, target), append([]any{now}, args...)...)
	g5Exec(store.Db, fmt.Sprintf(`UPDATE kernel_nodes SET pause_ms=COALESCE(pause_ms,0)+MAX(0,?-pause_since),pause_since=NULL
    WHERE %s AND graph_paused=0 AND node_paused=0 AND pause_since IS NOT NULL`, target), append([]any{now}, args...)...)
}

func FinishNativePauses(store *TaskStore, taskID string, nodeID *string, now ...int64) {
	at := ledgerNow(now)
	target := "task_id=?"
	args := []any{at, taskID}
	if nodeID != nil && *nodeID != "" {
		target = "task_id=? AND node_id=?"
		args = []any{at, taskID, *nodeID}
	}
	g5Exec(store.Db, fmt.Sprintf(`UPDATE kernel_nodes SET pause_ms=COALESCE(pause_ms,0)+MAX(0,?-pause_since),
    pause_since=NULL,graph_paused=0,node_paused=0 WHERE %s AND pause_since IS NOT NULL`, target), args...)
}

func NativePauseMs(store *TaskStore, taskID, nodeID string, now ...int64) *int64 {
	row, ok := g5One(store.Db, "SELECT pause_ms,pause_since FROM kernel_nodes WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok || (row["pause_ms"] == nil && row["pause_since"] == nil) {
		return nil
	}
	total := int64(0)
	if row["pause_ms"] != nil {
		total = g5Int(row["pause_ms"])
	}
	if row["pause_since"] != nil {
		delta := ledgerNow(now) - g5Int(row["pause_since"])
		if delta > 0 {
			total += delta
		}
	}
	return &total
}

func ledgerNow(now []int64) int64 {
	if len(now) > 0 {
		return now[0]
	}
	return NowMillis()
}
