package graph

func (k *KernelStore) MarkExecutionMissingRequired(executionID string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET missing_required=1 WHERE id=?", executionID)
}

func (k *KernelStore) ClearExecutionMissingRequired(executionID string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET missing_required=0 WHERE id=?", executionID)
}

func (k *KernelStore) MarkExecutionPendingGap(executionID, gap string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET missing_required=1,pending_gap=? WHERE id=?", gap, executionID)
}
