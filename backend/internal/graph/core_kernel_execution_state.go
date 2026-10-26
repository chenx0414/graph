package graph

// MarkExecutionMissingRequired says an execution still misses a required
// output.
func (k *KernelStore) MarkExecutionMissingRequired(executionID string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET missing_required=1 WHERE id=?", executionID)
}

// ClearExecutionMissingRequired says an execution misses nothing any more.
func (k *KernelStore) ClearExecutionMissingRequired(executionID string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET missing_required=0 WHERE id=?", executionID)
}

// MarkExecutionPendingGap says which required outputs an execution misses.
func (k *KernelStore) MarkExecutionPendingGap(executionID, gap string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET missing_required=1,pending_gap=? WHERE id=?", gap, executionID)
}
