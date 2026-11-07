package graph

func OpenPause(kernel *KernelStore, taskID string, now ...int64) {
	at := ledgerNow(now)
	kernel.SetNativePause(taskID, true, "", at)
	kernel.Store.OpenNodePause(taskID, at)
}

func ClosePause(kernel *KernelStore, taskID string, now ...int64) {
	at := ledgerNow(now)
	kernel.SetNativePause(taskID, false, "", at)
	kernel.Store.CloseNodePause(taskID, at)
}

func OpenUserWait(store *TaskStore, taskID, nodeID string, now ...int64) {
	store.OpenNodeUserWait(taskID, nodeID, ledgerNow(now))
}

func CloseUserWait(store *TaskStore, taskID, nodeID string, now ...int64) {
	at := ledgerNow(now)
	store.CloseNodeUserWait(taskID, nodeID, at)
}

func CloseUserWaitForOperation(store *TaskStore, operationID string, now ...int64) {
	operation, ok := g5One(store.Db, "SELECT task_id,node_id FROM operations WHERE id=?", operationID)
	if ok {
		CloseUserWait(store, g5Str(operation["task_id"]), g5Str(operation["node_id"]), ledgerNow(now))
	}
}

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

func ledgerNow(now []int64) int64 {
	if len(now) > 0 {
		return now[0]
	}
	return NowMillis()
}
