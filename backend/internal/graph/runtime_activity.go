package graph

func (runtime *TaskRuntime) ActiveOperationCount() int {
	if runtime.store == nil || runtime.store.Db == nil {
		return 0
	}
	row, ok := graphDBRow(runtime.store.Db, `SELECT COUNT(*) AS n FROM operations
        WHERE settled_at IS NULL
          AND state IN ('intent','prepared','dispatched','running','failed')`)
	if !ok {
		return 0
	}
	return int(graphDBInt(row, "n"))
}
