package graph

func kernelRecoveryNeeded(kernel *KernelStore) bool {
	for _, query := range []string{
		"SELECT 1 FROM kernel_executions WHERE state='running' LIMIT 1",
		"SELECT 1 FROM kernel_module_operations WHERE state='dispatched' OR worker_active=1 LIMIT 1",
		"SELECT 1 FROM kernel_provider_calls WHERE state='inflight' LIMIT 1",
	} {
		if kernelRow(kernel.Db, query) != nil {
			return true
		}
	}
	return false
}

func RecoverKernelExecutions(kernel *KernelStore) []string {
	if !kernelRecoveryNeeded(kernel) {
		return []string{}
	}
	interrupted := []string{}
	kernel.ModuleTransaction(func(kernel *KernelStore) any {
		ReconcileOperationResources(kernel)
		ReleaseOperationLeasesOnRestart(kernel, "owner_restart")
		kernelExec(kernel.Db, "UPDATE kernel_provider_calls SET state='unknown' WHERE state='inflight'")
		interruptedOperations := kernelRows(kernel.Db, "SELECT id,task_id,module_id,delivery_id FROM kernel_module_operations WHERE state='dispatched'")
		for _, operation := range interruptedOperations {
			kernelExec(kernel.Db, "UPDATE kernel_module_operations SET state='uncertain',error='Runtime interrupted after dispatch' WHERE id=?", operation["id"])
			taskId := kernelString(operation["task_id"])
			moduleId := kernelString(operation["module_id"])
			kernel.SetNodeQueuePaused(taskId, moduleId, true)
			kernel.Store.BlockTaskPhase(taskId)
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
			interrupted = append(interrupted, kernelString(row["id"]))
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
			kernelExec(kernel.Db, "UPDATE kernel_executions SET state=?,waiting_slot=0,ended_at=?,run_ms=NULL,waiting_ms=NULL,run_since=NULL,waiting_since=NULL WHERE id=?",
				executionState, NowMillis(), row["id"])
			kernelExec(kernel.Db, "UPDATE kernel_queue SET state=?,reason=? WHERE task_id=? AND node_id=? AND state='claimed'",
				queueState, reason, row["task_id"], row["node_id"])
			taskId := kernelString(row["task_id"])
			nodeId := kernelString(row["node_id"])
			kernel.SetNodeQueuePaused(taskId, nodeId, true)
			kernelExec(kernel.Db, "UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?", taskId, nodeId)
			kernel.Store.BlockTaskPhase(taskId)
			if !submitted && kernel.HasRecordedNodeQuestion(kernelString(row["id"])) {
				kernel.PublishRecordedNodeQuestion(kernelString(row["id"]), "The runtime was interrupted after this question was recorded. Inspect the execution and reconcile pending provider calls before answering.")
			} else {
				WakeForBlockedNode(kernel.Store, taskId, BlockedNodeWake{NodeID: nodeId, Reason: reason, IncidentID: kernelString(row["id"]), HasIncident: true})
			}
			kernel.Store.Event(taskId, "graph.execution.interrupted", map[string]any{
				"executionId": kernelString(row["id"]),
				"nodeId":      nodeId,
				"submitted":   submitted,
				"reason":      reason,
			})
		}
		for _, row := range kernelRows(kernel.Db, `SELECT n.execution_id FROM node_questions n
 JOIN kernel_executions e ON e.id=n.execution_id
 JOIN kernel_queue q ON q.task_id=n.task_id AND q.node_id=n.node_id AND q.seq=n.queue_seq
 WHERE n.state='recorded' AND e.state='blocked' AND e.submission_id IS NULL AND q.state='queued'`) {
			kernel.PublishRecordedNodeQuestion(kernelString(row["execution_id"]), "The execution was interrupted after this question was recorded. Inspect the execution and reconcile pending provider calls before answering.")
		}
		return nil
	})
	kernel.Store.ParkStalledTasks()
	return interrupted
}
