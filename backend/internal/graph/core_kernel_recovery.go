package graph

// RecoverKernelExecutions settles the executions the previous process left
// behind. It is called once, after acquiring the runtime owner lock; never
// during a live tick.
func RecoverKernelExecutions(kernel *KernelStore) int {
	result := kernel.ModuleTransaction(func() any {
		ReconcileOperationResources(kernel)
		// A prepared operation never crossed its send boundary; only its unused lease is safe to release.
		kernelExec(kernel.Db, "UPDATE kernel_module_operations SET worker_active=0 WHERE state='prepared'")
		kernelExec(kernel.Db, "UPDATE kernel_provider_calls SET state='unknown' WHERE state='inflight'")
		interruptedOperations := kernelRows(kernel.Db, "SELECT id,task_id,module_id,delivery_id FROM kernel_module_operations WHERE state='dispatched'")
		for _, operation := range interruptedOperations {
			kernelExec(kernel.Db, "UPDATE kernel_module_operations SET state='uncertain',error='Runtime interrupted after dispatch' WHERE id=?", operation["id"])
			taskId := kernelString(operation["task_id"])
			moduleId := kernelString(operation["module_id"])
			kernel.SetNodeQueuePaused(taskId, moduleId, true)
			kernelExec(kernel.Db, "UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')", taskId)
			WakeForBlockedNode(kernel.Store, taskId, BlockedNodeWake{
				NodeID:      moduleId,
				Reason:      "Host operation interrupted after dispatch; inspect side effects before resuming",
				IncidentID:  kernelString(operation["id"]),
				HasIncident: true,
			})
			kernel.Store.Event(taskId, "graph.operation.interrupted", map[string]any{
				"operationId": kernelString(operation["id"]),
				"moduleId":    moduleId,
				"deliveryId":  kernelString(operation["delivery_id"]),
			})
		}
		rows := kernelRows(kernel.Db, "SELECT id,task_id,node_id,submission_id,token_reservation FROM kernel_executions WHERE state='running'")
		for _, row := range rows {
			// Calls are journaled before sending. With no unresolved call, this turn's
			// unused hold is safe to release; a resumed turn will reserve afresh.
			unresolvedCall := kernelRow(kernel.Db, "SELECT 1 FROM kernel_provider_calls WHERE execution_id=? AND state IN ('inflight','unknown') LIMIT 1", row["id"])
			reservation := kernelInt(row["token_reservation"])
			if reservation > 0 && unresolvedCall == nil {
				kernelExec(kernel.Db, "UPDATE kernel_node_state SET reserved=MAX(0,reserved-?) WHERE task_id=? AND node_id=?",
					reservation, row["task_id"], row["node_id"])
				kernelExec(kernel.Db, "UPDATE kernel_executions SET token_reservation=0 WHERE id=?", row["id"])
			}
			submitted := row["submission_id"] != nil && kernelString(row["submission_id"]) != ""
			reason := "Runtime interrupted; input and attempt counters retained. Check side effects and reconcile unknown usage before resuming."
			executionState := "blocked"
			queueState := "queued"
			if submitted {
				reason = "Runtime interrupted after submit; output is retained. Handle remaining work without resending."
				executionState = "failed"
				queueState = "failed"
			}
			// The process died without a closing boundary. Do not charge owner downtime
			// as work or pretend the execution's full duration was measured.
			kernelExec(kernel.Db, "UPDATE kernel_executions SET state=?,waiting_slot=0,ended_at=?,run_ms=NULL,waiting_ms=NULL,run_since=NULL,waiting_since=NULL WHERE id=?",
				executionState, NowMillis(), row["id"])
			kernelExec(kernel.Db, "UPDATE kernel_queue SET state=?,reason=? WHERE task_id=? AND node_id=? AND state='claimed'",
				queueState, reason, row["task_id"], row["node_id"])
			taskId := kernelString(row["task_id"])
			nodeId := kernelString(row["node_id"])
			kernel.SetNodeQueuePaused(taskId, nodeId, true)
			kernelExec(kernel.Db, "UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?", taskId, nodeId)
			kernelExec(kernel.Db, "UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')", taskId)
			kernel.Store.Event(taskId, "graph.execution.interrupted", map[string]any{
				"executionId": kernelString(row["id"]),
				"nodeId":      nodeId,
				"submitted":   submitted,
				"reason":      reason,
			})
		}
		return len(rows) + len(interruptedOperations)
	})
	count, _ := result.(int)
	return count
}
