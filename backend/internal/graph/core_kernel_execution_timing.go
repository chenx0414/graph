package graph

// SetExecutionWaiting opens or closes the credential/slot wait on one
// running execution.
func (k *KernelStore) SetExecutionWaiting(executionID string, waiting bool, now ...int64) {
	at := NowMillis()
	if len(now) > 0 {
		at = now[0]
	}
	update := func() {
		var changes int64
		if waiting {
			changes, _ = g5Exec(k.Db, `UPDATE kernel_executions SET
          run_ms=run_ms+CASE WHEN run_since IS NULL THEN 0 ELSE MAX(0,?-run_since) END,
          run_since=NULL,waiting_since=?,waiting_slot=1
          WHERE id=? AND state='running' AND waiting_slot=0`, at, at, executionID)
		} else {
			changes, _ = g5Exec(k.Db, `UPDATE kernel_executions SET
          waiting_ms=waiting_ms+CASE WHEN waiting_since IS NULL THEN 0 ELSE MAX(0,?-waiting_since) END,
          waiting_since=NULL,run_since=?,waiting_slot=0
          WHERE id=? AND state='running' AND waiting_slot=1`, at, at, executionID)
		}
		if changes != 0 {
			row, _ := g5One(k.Db, "SELECT task_id,node_id FROM kernel_executions WHERE id=?", executionID)
			k.Store.Event(g5Str(row["task_id"]), "graph.execution.waiting", map[string]any{
				"executionId": executionID, "nodeId": g5Str(row["node_id"]), "waiting": waiting,
			})
		}
	}
	if k.Store.IsTransaction() {
		update()
		return
	}
	k.Store.Transaction(update)
}

// CloseExecutionTiming ends a measured segment at its terminal boundary.
func (k *KernelStore) CloseExecutionTiming(executionID string, now ...int64) {
	at := NowMillis()
	if len(now) > 0 {
		at = now[0]
	}
	g5Exec(k.Db, `UPDATE kernel_executions SET
    run_ms=run_ms+CASE WHEN run_since IS NULL THEN 0 ELSE MAX(0,?-run_since) END,
    waiting_ms=waiting_ms+CASE WHEN waiting_since IS NULL THEN 0 ELSE MAX(0,?-waiting_since) END,
    run_since=NULL,waiting_since=NULL,waiting_slot=0 WHERE id=?`, at, at, executionID)
}
