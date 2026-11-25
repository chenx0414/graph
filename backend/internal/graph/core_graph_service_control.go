package graph

const staleWorkerMs = 10 * 60 * 1000

func (service *graphManagementService) GraphControl(input GraphControlInput) any {
	graph := service.runtime(input.GraphId)
	phase := GraphPhase("")
	if state := graph.State(); state != nil {
		phase = state.Phase
	}
	switch input.Action {
	case "pause", "resume", "reopen", "retry", "skip", "cancel", "retry_preparation":
		if phase.Closed() {
			Raise("invalid_graph", "Ended graph cannot change its execution controls")
		}
	}
	switch input.Action {
	case "relayout":
		service.kernel.ResetGraphLayout(input.GraphId)
		service.kernel.Store.Event(input.GraphId, "graph.layout_reset", map[string]any{})
		return map[string]any{"state": "layout_reset"}
	case "cancel_operation":
		operationId := ""
		if input.OperationId != nil {
			operationId = *input.OperationId
		}
		owned := kernelRow(service.kernel.Db, "SELECT id FROM kernel_module_operations WHERE task_id=? AND id=?", input.GraphId, operationId)
		if owned != nil {
			ReconcileOperationResources(service.kernel, operationId)
		}
		operation := kernelRow(service.kernel.Db, "SELECT delivery_id,module_id,state,worker_active,COALESCE(started_at,created_at) AS dispatched_at FROM kernel_module_operations WHERE task_id=? AND id=?", input.GraphId, operationId)
		if operation == nil {
			Raise("invalid_operation", "Only an interrupted or failed operation can be cancelled; stop active work first")
		}
		state := kernelString(operation["state"])
		if state != "uncertain" && state != "failed" && state != "unknown" && state != "cancelled" {
			Raise("invalid_operation", "Only an interrupted or failed operation can be cancelled; stop active work first")
		}
		if kernelInt(operation["worker_active"]) != 0 {
			if kernelInt(operation["dispatched_at"]) > NowMillis()-staleWorkerMs || service.kernel.HasPendingProviderCall(input.GraphId, kernelString(operation["module_id"])) {
				Raise("invalid_operation", "Operation still holds execution resources; verify termination before cancelling")
			}
			service.kernel.ReleaseModuleOperationWorker(operationId)
		}
		if state == "cancelled" {
			return graph.State()
		}
		deliveryId := kernelString(operation["delivery_id"])
		moduleId := kernelString(operation["module_id"])
		service.kernel.ModuleTransaction(func() any {
			service.kernel.CancelModuleOperation(operationId)
			service.kernel.MarkDeliveryProcessed(deliveryId)
			service.kernel.Store.Event(input.GraphId, unjudgedEvent, map[string]any{
				"operationId": operationId,
				"deliveryId":  deliveryId,
				"moduleId":    moduleId,
				"reasonCode":  "cancelled_without_verdict",
			})
			service.kernel.SetNodeQueuePaused(input.GraphId, moduleId, false)
			service.kernel.Store.CompleteBlockedTask(input.GraphId)
			service.kernel.Store.Event(input.GraphId, "graph.operation.cancelled", map[string]any{
				"operationId": operationId,
				"deliveryId":  deliveryId,
				"moduleId":    moduleId,
			})
			return nil
		})
		return graph.State()
	case "reconcile_usage":
		if input.CallId == nil || *input.CallId == "" || input.Usage == nil {
			Raise("invalid_input", "reconcile_usage requires callId and usage")
		}
		return ReconcileKernelUsage(service.kernel, input.GraphId, *input.CallId, *input.Usage)
	case "retry_preparation":
		return service.retryGraphPreparation(input.GraphId, input.Proof)
	case "sync_integration":
		return SyncIntegrationSha(service.kernel, input.GraphId)
	case "complete":
		return graph.Complete()
	case "withdraw_complete":
		return graph.WithdrawComplete()
	case "complete_with_limitations":
		return service.completeWithLimitations(input.GraphId, input)
	case "stop":
		return graph.Stop()
	case "reopen":
		if input.ModuleId == nil || *input.ModuleId == "" {
			Raise("invalid_input", "reopen requires moduleId")
		}
		latest := service.kernel.LatestRevision(input.GraphId)
		if latest == nil {
			Raise("invalid_graph", "Target has no graph definition")
		}
		return NewModuleRuntime(service.kernel, input.GraphId, latest.Version).ReopenAfterPending(*input.ModuleId)
	case "pause", "resume":
		if input.NodeId != nil && input.ModuleId != nil {
			Raise("invalid_input", "Pause/resume accepts either nodeId or moduleId")
		}
		target := ""
		hasTarget := false
		if input.ModuleId != nil {
			target = *input.ModuleId
			hasTarget = true
		} else if input.NodeId != nil {
			target = *input.NodeId
			hasTarget = true
		}
		paused := input.Action == "pause"
		if hasTarget {
			latest := service.kernel.LatestRevision(input.GraphId)
			if latest == nil {
				Raise("invalid_graph", "Target has no graph definition")
			}
			known := false
			if input.ModuleId != nil {
				_, known = latest.Definition.Modules[target]
			} else {
				_, known = latest.Definition.Nodes[target]
			}
			if !known {
				Raise("invalid_input", "Pause/resume requires a target in the current graph definition")
			}
			service.kernel.Store.Transaction(func(tx *TaskStore) any {
		kernel := service.kernel.scoped(tx)
				if !paused {
					requireProjectActive(kernel.Store, kernel.Store.Task(input.GraphId).ProjectID)
					if input.AgentTaskID != "" {
						requireArchiveResumeInstruction(kernel.Store, input.AgentTaskID, input.GraphId, input.SourceMessageID, input.Instruction)
					}
				}
				kernel.SetQuestionManualPause(input.GraphId, target, paused)
				kernel.SetNodeQueuePausedInCurrentTransaction(input.GraphId, target, paused)
				if !paused {
					kernel.UnblockNode(input.GraphId, target)
				}
				kernel.SetNativePause(input.GraphId, paused, target, 0)
				return nil
			})
			return graph.State()
		}
		service.kernel.Store.Transaction(func(tx *TaskStore) any {
		kernel := service.kernel.scoped(tx)
			if !paused && input.AgentTaskID != "" {
				requireArchiveResumeInstruction(kernel.Store, input.AgentTaskID, input.GraphId, input.SourceMessageID, input.Instruction)
			}
			kernel.Store.SetTaskPaused(input.GraphId, paused)
			kernel.SetNativePause(input.GraphId, paused, "", 0)
			return nil
		})
		return graph.State()
	case "retry", "skip", "cancel":
		if input.Seq == nil {
			Raise("invalid_input", input.Action+" requires queue seq")
		}
		seq := *input.Seq
		row := kernelRow(service.kernel.Db, "SELECT node_id,state FROM kernel_queue WHERE task_id=? AND seq=?", input.GraphId, seq)
		if row == nil {
			Raise("invalid_queue", "Queue item is absent, still executing, or already settled")
		}
		state := kernelString(row["state"])
		if state == "claimed" || state == "done" {
			Raise("invalid_queue", "Queue item is absent, still executing, or already settled")
		}
		nodeId := kernelString(row["node_id"])
		base := "exec-" + input.GraphId + "-" + nodeId + "-" + itoa(seq)
		submitted := kernelRow(service.kernel.Db, "SELECT submission_id FROM kernel_executions WHERE task_id=? AND node_id=? AND submission_id IS NOT NULL AND (id=? OR instr(id,?)=1)",
			input.GraphId, nodeId, base, base+"-")
		if input.Action == "retry" && submitted != nil {
			Raise("invalid_queue", "Submitted work cannot be sent again")
		}
		service.kernel.Store.Transaction(func(tx *TaskStore) any {
		kernel := service.kernel.scoped(tx)
			requireProjectActive(kernel.Store, kernel.Store.Task(input.GraphId).ProjectID)
			if input.Action == "retry" && kernel.HasPendingProviderCall(input.GraphId, nodeId) {
				Raise("unknown_usage", "Reconcile the node's pending provider calls before retrying")
			}
			if kernelRow(kernel.Db, "SELECT id FROM node_questions WHERE task_id=? AND node_id=? AND queue_seq=? AND state IN ('recorded','parked')", input.GraphId, nodeId, seq) != nil {
				Raise("invalid_queue", "The node question must be resolved before changing its queue item")
			}
			if input.Action == "retry" {
				kernel.RetryQueueItem(input.GraphId, int64(seq), input.Action)
			} else {
				kernel.SettleQueueItem(input.GraphId, int64(seq), input.Action)
			}
			kernel.UnpauseNodeState(input.GraphId, nodeId)
			kernel.SetNativePause(input.GraphId, false, nodeId, 0)
			kernel.ReleaseNode(input.GraphId, nodeId)
			kernel.Store.CompleteBlockedTask(input.GraphId)
			kernel.Store.Event(input.GraphId, "graph.queue."+input.Action, map[string]any{"seq": seq, "nodeId": nodeId})
			return nil
		})
		return graph.State()
	}
	Raise("invalid_input", "Unknown graph control action "+input.Action)
	return nil
}
