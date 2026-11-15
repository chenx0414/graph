package graph

import "fmt"

func (k *KernelStore) SetNativePause(taskID string, paused bool, nodeID string, now int64) {
	if _, ok := g5One(k.Db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_nodes'"); !ok {
		return
	}
	phase := k.Store.Task(taskID).Phase
	if paused && GraphPhase(phase).Closed() {
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
	g5Exec(k.Db, fmt.Sprintf("UPDATE kernel_nodes SET %s=? WHERE %s AND status!='retired'", column, target), append([]any{flag}, args...)...)
	g5Exec(k.Db, fmt.Sprintf(`UPDATE kernel_nodes SET pause_since=? WHERE %s AND status!='retired'
    AND (graph_paused=1 OR node_paused=1) AND pause_since IS NULL`, target), append([]any{now}, args...)...)
	g5Exec(k.Db, fmt.Sprintf(`UPDATE kernel_nodes SET pause_ms=COALESCE(pause_ms,0)+MAX(0,?-pause_since),pause_since=NULL
    WHERE %s AND graph_paused=0 AND node_paused=0 AND pause_since IS NOT NULL`, target), append([]any{now}, args...)...)
}

func (k *KernelStore) NativePauseMs(taskID, nodeID string, now ...int64) *int64 {
	row, ok := g5One(k.Db, "SELECT pause_ms,pause_since FROM kernel_nodes WHERE task_id=? AND node_id=?", taskID, nodeID)
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

func (k *KernelStore) FinishNativePauses(taskID string, nodeID *string, now ...int64) {
	at := ledgerNow(now)
	target := "task_id=?"
	args := []any{at, taskID}
	if nodeID != nil && *nodeID != "" {
		target = "task_id=? AND node_id=?"
		args = []any{at, taskID, *nodeID}
	}
	g5Exec(k.Db, fmt.Sprintf(`UPDATE kernel_nodes SET pause_ms=COALESCE(pause_ms,0)+MAX(0,?-pause_since),
    pause_since=NULL,graph_paused=0,node_paused=0 WHERE %s AND pause_since IS NOT NULL`, target), args...)
}
