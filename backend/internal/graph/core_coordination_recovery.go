package graph

func (runtime *TaskRuntime) recoverWorkGraphs() {
	for _, item := range runtime.store.PreparingWorkGraphs() {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					runtime.store.Transaction(func() any {
						runtime.store.Event(item.OwnerTaskID, "work.graph.recovery.failed", map[string]any{"workId": item.WorkID, "graphKey": item.GraphKey, "reason": graphServiceErrorMessage(recovered)})
						return nil
					})
				}
			}()
			runtime.ConfirmWorkGraph(item.WorkID, WorkConfirmInput{WorkRevision: item.WorkRevision, Version: item.Version, DraftRevision: item.DraftRevision, GraphKey: item.GraphKey, TargetBranch: item.TargetBranch}, "recovery:"+item.KernelRequestID)
		}()
	}
}

func (runtime *TaskRuntime) recoverTransferredGraphPreparations() {
	rows := kernelRows(runtime.store.Db, `SELECT r.graph_id,r.owner_task_id,r.request_id,r.content,t.project_id
 FROM kernel_create_requests r JOIN kernel_graph_owners g ON g.task_id=r.graph_id
 JOIN tasks t ON t.id=r.graph_id LEFT JOIN projects p ON p.id=t.project_id
 WHERE r.state='preparing' AND g.owner_task_id!=r.owner_task_id AND p.archived_at IS NULL
 AND COALESCE((SELECT MAX(e.cursor) FROM events e WHERE e.task_id=r.graph_id AND e.type='graph.preparation.recovery_required'),0)
 <= COALESCE((SELECT MAX(e.cursor) FROM events e WHERE e.task_id=r.graph_id AND e.type='graph.preparation.recovery_cleared'),0)
 AND NOT EXISTS (SELECT 1 FROM project_archive_pauses a WHERE a.task_id=r.graph_id)
 AND NOT EXISTS (SELECT 1 FROM work_graphs wg JOIN work_requests w ON w.id=wg.work_id WHERE wg.graph_id=r.graph_id AND w.execution_paused=1)`)
	for _, row := range rows {
		item := row
		go func() {
			defer func() { _ = recover() }()
			content := questionParseRecord(kernelString(item["content"]))
			branch, ok := content["targetBranch"].(string)
			if !ok || branch == "" {
				return
			}
			service := &graphManagementService{kernel: runtime.kernel, prepare: func(graphID, target string) {
				if runtime.git == nil {
					Raise("invalid_input", "Git preparation is unavailable")
				}
				runtime.git.PrepareTask(graphID, target)
			}}
			graphID := kernelString(item["graph_id"])
			reason := service.prepareGraph(graphID, kernelString(item["owner_task_id"]), kernelString(item["request_id"]), branch, kernelString(item["project_id"]), false)
			if reason != "" {
				WakeForBlockedNode(runtime.store, graphID, BlockedNodeWake{NodeID: "@preparation", Reason: reason, IncidentID: graphID, HasIncident: true})
			}
			if runtime.autoWake {
				runtime.execution.Kick()
			}
		}()
	}
}

func (runtime *TaskRuntime) markInterruptedGraphPreparations() {
	runtime.store.Transaction(func() any {
		rows := kernelRows(runtime.store.Db, `SELECT r.graph_id FROM kernel_create_requests r WHERE r.state='preparing'
 AND COALESCE((SELECT MAX(e.cursor) FROM events e WHERE e.task_id=r.graph_id AND e.type='graph.preparation.recovery_required'),0)
 <= COALESCE((SELECT MAX(e.cursor) FROM events e WHERE e.task_id=r.graph_id AND e.type='graph.preparation.recovery_cleared'),0)`)
		for _, row := range rows {
			graphID := kernelString(row["graph_id"])
			reason := "Git preparation was interrupted; inspect its process and worktree before retrying"
			runtime.store.Event(graphID, "graph.preparation.recovery_required", map[string]any{"graphId": graphID, "reason": reason})
			WakeForBlockedNode(runtime.store, graphID, BlockedNodeWake{NodeID: "@preparation", Reason: reason, IncidentID: graphID, HasIncident: true})
		}
		return nil
	})
}
