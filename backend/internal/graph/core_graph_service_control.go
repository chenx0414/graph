package graph

// GraphControl drives a graph's execution controls.
func (service *graphManagementService) GraphControl(input GraphControlInput) any {
	graph := service.runtime(input.GraphId)
	phase := GraphPhase("")
	if state := graph.State(); state != nil {
		phase = state.Phase
	}
	switch input.Action {
	case "pause", "resume", "reopen", "retry", "skip", "cancel":
		if phase == "completed" || phase == "stopping" || phase == "stopped" {
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
		operation := kernelRow(service.kernel.Db, "SELECT delivery_id,module_id,state,worker_active FROM kernel_module_operations WHERE task_id=? AND id=?", input.GraphId, operationId)
		if operation == nil {
			Raise("invalid_operation", "Only an interrupted or failed operation can be cancelled; stop active work first")
		}
		state := kernelString(operation["state"])
		if state != "uncertain" && state != "failed" && state != "cancelled" {
			Raise("invalid_operation", "Only an interrupted or failed operation can be cancelled; stop active work first")
		}
		if kernelInt(operation["worker_active"]) != 0 {
			Raise("invalid_operation", "Operation still holds execution resources; verify termination before cancelling")
		}
		if state == "cancelled" {
			return graph.State()
		}
		deliveryId := kernelString(operation["delivery_id"])
		moduleId := kernelString(operation["module_id"])
		service.kernel.ModuleTransaction(func() any {
			service.kernel.CancelModuleOperation(operationId)
			service.kernel.MarkDeliveryProcessed(deliveryId)
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
	case "complete":
		return graph.Complete()
	case "withdraw_complete":
		return graph.WithdrawComplete()
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
			service.kernel.SetNodeQueuePaused(input.GraphId, target, paused)
			if !paused {
				service.kernel.UnblockNode(input.GraphId, target)
			}
		} else {
			service.kernel.Store.SetTaskPaused(input.GraphId, paused)
		}
		targetNode := ""
		if hasTarget {
			targetNode = target
		}
		SetNativePause(service.kernel.Store, input.GraphId, paused, targetNode, 0)
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
		// Stable node ids are literal text, never a wildcard expression.
		base := "exec-" + input.GraphId + "-" + nodeId + "-" + itoa(seq)
		submitted := kernelRow(service.kernel.Db, "SELECT submission_id FROM kernel_executions WHERE task_id=? AND node_id=? AND submission_id IS NOT NULL AND (id=? OR instr(id,?)=1)",
			input.GraphId, nodeId, base, base+"-")
		if input.Action == "retry" && submitted != nil {
			Raise("invalid_queue", "Submitted work cannot be sent again")
		}
		service.kernel.Store.Transaction(func() any {
			if input.Action == "retry" {
				service.kernel.RetryQueueItem(input.GraphId, int64(seq), input.Action)
			} else {
				service.kernel.SettleQueueItem(input.GraphId, int64(seq), input.Action)
			}
			service.kernel.UnpauseNodeState(input.GraphId, nodeId)
			SetNativePause(service.kernel.Store, input.GraphId, false, nodeId, 0)
			service.kernel.ReleaseNode(input.GraphId, nodeId)
			service.kernel.Store.CompleteBlockedTask(input.GraphId)
			service.kernel.Store.Event(input.GraphId, "graph.queue."+input.Action, map[string]any{"seq": seq, "nodeId": nodeId})
			return nil
		})
		return graph.State()
	}
	Raise("invalid_input", "Unknown graph control action "+input.Action)
	return nil
}
