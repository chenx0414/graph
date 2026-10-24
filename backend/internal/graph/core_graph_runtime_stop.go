package graph

// Stop cancels queued work and blocks new dispatch.
func (runtime *GraphRuntime) Stop() GraphStateRow {
	runtime.ensureTask()
	phase := runtime.State().Phase
	if phase == "completed" || phase == "stopped" {
		return *runtime.State()
	}
	FinishNativePauses(runtime.kernel.Store, runtime.graphId, nil)
	runtime.kernel.Store.StopTask(runtime.graphId)
	runtime.kernel.MarkGraphDeliveriesProcessed(runtime.graphId)
	runtime.kernel.RouteGraphTransitions(runtime.graphId)
	runtime.kernel.CancelQueuedWork(runtime.graphId, "cancelled by stop")
	runtime.kernel.Store.Event(runtime.graphId, "graph.stopping", map[string]any{})
	return *runtime.State()
}

// SettleStop settles once queued work is cancelled and in-flight executions stop.
func (runtime *GraphRuntime) SettleStop() string {
	runtime.ensureTask()
	if runtime.State().Phase == "stopped" {
		return "stopped"
	}
	if runtime.State().Phase != "stopping" {
		Raise("invalid_graph", "Graph "+runtime.graphId+" is not stopping")
	}
	runtime.kernel.CancelQueuedWork(runtime.graphId, "cancelled by stop")
	queued := kernelInt(kernelRow(runtime.kernel.DB, "SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')", runtime.graphId)["n"])
	running := kernelInt(kernelRow(runtime.kernel.DB, "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND state='running'", runtime.graphId)["n"])
	if queued > 0 || running > 0 {
		return "stopping"
	}
	runtime.kernel.ModuleTransaction(func() any {
		runtime.setPhase("stopped")
		WakeMaster(runtime.kernel.Store, WakeIntent{TaskID: runtime.graphId, Kind: "task_stopped", DedupeKey: runtime.graphId + ":stopped", Data: map[string]any{"graphId": runtime.graphId}, HasData: true})
		runtime.kernel.Store.Event(runtime.graphId, "graph.stopped", map[string]any{"revision": runtime.State().Revision})

		return nil
	})
	return "stopped"
}

// Inspect reads summary, revision, or nodes.
func (runtime *GraphRuntime) Inspect(kind string) any {
	runtime.ensureTask()
	latest := runtime.kernel.LatestRevision(runtime.graphId)
	switch kind {
	case "summary":
		return map[string]any{"graphId": runtime.graphId, "phase": runtime.State().Phase, "revision": latest.Version, "name": latest.Definition.Name}
	case "revision":
		return latest.Definition
	case "nodes":
		rows := kernelRows(runtime.kernel.DB, "SELECT node_id, instance_id, kind, status FROM kernel_nodes WHERE task_id=?", runtime.graphId)
		out := make([]any, len(rows))
		for i, row := range rows {
			out[i] = map[string]any{"id": kernelString(row["node_id"]), "instanceId": kernelString(row["instance_id"]), "kind": kernelString(row["kind"]), "status": kernelString(row["status"])}
		}
		return out
	default:
		Raise("invalid_query", "Unknown inspect query "+kind)
	}
	return nil
}
