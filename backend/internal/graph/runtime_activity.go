package graph

// ActiveOperationCount is the durable answer to "is work in flight": an operation
// that was dispatched or is running a worker. The app asks this before replacing
// its process, so a build waits instead of ending a live turn.
func (runtime *TaskRuntime) ActiveOperationCount() int {
	if runtime.store == nil || runtime.store.Db == nil {
		return 0
	}
	row, ok := graphDBRow(runtime.store.Db, `SELECT COUNT(*) AS n FROM operations
        WHERE state='intent' OR (worker_active=1 AND state IN ('prepared','dispatched','running'))`)
	if !ok {
		return 0
	}
	return int(graphDBInt(row, "n"))
}
