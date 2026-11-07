package graph

import "encoding/json"

func ReconcileOperationResources(kernel *KernelStore, operationID ...string) {
	kernel.ModuleTransaction(func() any {
		query := `SELECT id,task_id,resource_receipt FROM kernel_module_operations
      WHERE worker_active=1 AND resource_receipt IS NOT NULL AND state IN ('dispatched','uncertain','failed','unknown')`
		args := []any{}
		if len(operationID) > 0 {
			query += " AND id=?"
			args = append(args, operationID[0])
		}
		rows := sqliteRows(kernel.Store.DB, query, args...)
		for _, row := range rows {
			var receipt ProcessQuiescenceReceipt
			if err := json.Unmarshal([]byte(sqlString(row["resource_receipt"])), &receipt); err != nil {
				continue
			}
			if receipt.Path == "" || receipt.Nonce == "" || !HasProcessQuiescence(receipt) {
				continue
			}
			changed := sqliteChanges(kernel.Store.DB, "UPDATE kernel_module_operations SET worker_active=0 WHERE id=? AND worker_active=1", sqlString(row["id"]))
			if changed != 0 {
				kernel.Store.Event(sqlString(row["task_id"]), "graph.operation.resources_released", map[string]any{
					"operationId": sqlString(row["id"]),
					"source":      "supervisor",
				})
			}
		}
		return nil
	})
}

func ReleaseOperationLeasesOnRestart(kernel *KernelStore, reason string) int {
	return releaseOperationLeases(kernel, reason, "worker_active=1", nil)
}

func ReclaimStaleOperationLeases(kernel *KernelStore, reason string) int {
	return releaseOperationLeases(kernel, reason,
		"worker_active=1 AND started_at IS NOT NULL AND started_at < ?", []any{runtimeLeaseEpoch})
}

func releaseOperationLeases(kernel *KernelStore, reason, held string, args []any) int {
	released := 0
	kernel.ModuleTransaction(func() any {
		rows := sqliteRows(kernel.Store.DB, "SELECT id,task_id FROM kernel_module_operations WHERE "+held, args...)
		for _, row := range rows {
			changed := sqliteChanges(kernel.Store.DB, "UPDATE kernel_module_operations SET worker_active=0 WHERE id=? AND worker_active=1", sqlString(row["id"]))
			if changed == 0 {
				continue
			}
			released++
			kernel.Store.Event(sqlString(row["task_id"]), "graph.operation.resources_released", map[string]any{
				"operationId": sqlString(row["id"]),
				"source":      "recovery",
				"reason":      reason,
			})
		}
		return nil
	})
	return released
}
