package graph

import "encoding/json"

// ReconcileOperationResources releases resources and says nothing about whether an interrupted operation succeeded.
// Omit operationID (no extra arg) to scan every active receipt. A passed id restricts the scan.
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

// ReleaseOperationLeasesOnRestart frees every program slot the previous process
// still held.
//
// It runs once, after the runtime owner lock is acquired, so the judgment is the
// lock and not a clock: one process owns a graph at a time, therefore a lease
// recorded by anyone else belongs to a process that is gone. Releasing only the
// prepared leases used to leave an interrupted operation holding one of the four
// program slots for ever.
func ReleaseOperationLeasesOnRestart(kernel *KernelStore, reason string) int {
	return releaseOperationLeases(kernel, reason, "worker_active=1", nil)
}

// ReclaimStaleOperationLeases frees program slots recorded before this process
// started.
//
// The judgment is the timestamp, and it is checkable: nothing here can have
// dispatched an attempt before the process running the queue started, so the
// process that recorded these leases is not the one waiting now. A queue behind
// them would otherwise wait for a holder that never comes back.
func ReclaimStaleOperationLeases(kernel *KernelStore, reason string) int {
	return releaseOperationLeases(kernel, reason,
		"worker_active=1 AND started_at IS NOT NULL AND started_at < ?", []any{runtimeLeaseEpoch})
}

// releaseOperationLeases frees the leases the predicate names, and records each
// release with the reason it could be judged abandoned.
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
