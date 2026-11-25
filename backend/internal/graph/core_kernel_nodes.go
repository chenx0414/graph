package graph

func (k *KernelStore) ListNodes(taskID string) []KernelNodeView {
	revision := k.LatestRevision(taskID)
	if revision == nil {
		return []KernelNodeView{}
	}
	rows := g5Query(k.Db, "SELECT node_id,instance_id,kind,status,revision_version FROM kernel_nodes WHERE task_id=? AND revision_version=? ORDER BY node_id", taskID, revision.Version)
	out := make([]KernelNodeView, 0, len(rows))
	for _, row := range rows {
		out = append(out, KernelNodeView{NodeId: g5Str(row["node_id"]), InstanceId: g5Str(row["instance_id"]), Kind: g5Str(row["kind"]), Status: g5Str(row["status"]), RevisionVersion: int(g5Int(row["revision_version"]))})
	}
	return out
}

func (k *KernelStore) NodeStatus(taskID, nodeID string) string {
	row, ok := g5One(k.Db, "SELECT status FROM kernel_nodes WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok {
		return "idle"
	}
	return g5Str(row["status"])
}

func (k *KernelStore) RecordNodeBinding(taskID, nodeID, modelID, systemPrompt, tools, stateDir, role, environment string) {
	g5Exec(k.Db, "INSERT INTO kernel_node_bindings(task_id,node_id,model_id,system_prompt,tools,state_dir,role,environment) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,node_id) DO UPDATE SET model_id=excluded.model_id,system_prompt=excluded.system_prompt,tools=excluded.tools,state_dir=excluded.state_dir,role=excluded.role,environment=excluded.environment",
		taskID, nodeID, modelID, systemPrompt, tools, stateDir, role, environment)
}

func (k *KernelStore) NodeInstanceID(taskID, nodeID string) (string, bool) {
	row, ok := g5One(k.Db, "SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok {
		return "", false
	}
	return g5Str(row["instance_id"]), true
}

func (k *KernelStore) blockedWake(taskID, nodeID, reason string) {
	row, ok := g5One(k.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1", taskID, nodeID)
	wake := BlockedNodeWake{NodeID: nodeID, Reason: reason}
	if ok {
		wake.IncidentID = g5Str(row["id"])
		wake.HasIncident = true
	}
	WakeForBlockedNode(k.Store, taskID, wake)
}

func (k *KernelStore) FailNode(taskID, nodeID, reason string) {
	if k.settleNodeAfterStop(taskID, nodeID) {
		k.Store.Event(taskID, "graph.node.cancelled", map[string]any{"nodeId": nodeID, "reason": reason})
		return
	}
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='failed' WHERE task_id=? AND node_id=?", taskID, nodeID)
	k.Store.Event(taskID, "graph.node.failed", map[string]any{"nodeId": nodeID, "reason": reason})
	k.blockedWake(taskID, nodeID, reason)
}

func (k *KernelStore) NoteQueueFailure(taskID string, seq int64, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET reason=? WHERE task_id=? AND seq=?", reason, taskID, seq)
}

func (k *KernelStore) CompleteNode(taskID, nodeID string) {
	if k.settleNodeAfterStop(taskID, nodeID) {
		k.Store.Event(taskID, "graph.node.cancelled", map[string]any{"nodeId": nodeID})
		return
	}
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='succeeded' WHERE task_id=? AND node_id=?", taskID, nodeID)
}

func (k *KernelStore) BlockNode(taskID, nodeID, reason string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?", taskID, nodeID)
	k.Store.Event(taskID, "graph.node.blocked", map[string]any{"nodeId": nodeID, "reason": reason})
	k.blockedWake(taskID, nodeID, reason)
}

func (k *KernelStore) ParkNodeForQuestion(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?", taskID, nodeID)
}

func (k *KernelStore) ensureNodeState(taskID, nodeID string) {
	g5Exec(k.Db, "INSERT OR IGNORE INTO kernel_node_state(task_id,node_id) VALUES(?,?)", taskID, nodeID)
}

func (k *KernelStore) NoteNodeAttempt(taskID, nodeID string) {
	k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		k.ensureNodeState(taskID, nodeID)
		g5Exec(k.Db, "UPDATE kernel_node_state SET attempts=attempts+1 WHERE task_id=? AND node_id=?", taskID, nodeID)
		return nil
	})
}

func (k *KernelStore) NoteNodeResubmit(taskID, nodeID string, allowed int) {
	k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		k.ensureNodeState(taskID, nodeID)
		used := k.NodeState(taskID, nodeID).ResubmitsUsed
		if used >= allowed {
			Raise("invalid_queue", "Node "+nodeID+" already used its "+kernelItoa(int64(allowed))+" auto-resubmit(s)")
		}
		g5Exec(k.Db, "UPDATE kernel_node_state SET resubmits_used=resubmits_used+1 WHERE task_id=? AND node_id=?", taskID, nodeID)
		return nil
	})
}

func (k *KernelStore) SetNodeQueuePaused(taskID, nodeID string, paused bool) {
	k.ModuleTransaction(func() any {
		k.SetNodeQueuePausedInCurrentTransaction(taskID, nodeID, paused)
		return nil
	})
}

func (k *KernelStore) SetNodeQueuePausedInCurrentTransaction(taskID, nodeID string, paused bool) {
	k.ensureNodeState(taskID, nodeID)
	flag := 0
	if paused {
		flag = 1
	}
	g5Exec(k.Db, "UPDATE kernel_node_state SET paused=? WHERE task_id=? AND node_id=?", flag, taskID, nodeID)
	if !paused {
		k.SetNativePause(taskID, false, nodeID, 0)
	}
}

func (k *KernelStore) ConfigureNodeRetries(taskID, nodeID string, config NodeRetryConfig) {
	k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		k.ensureNodeState(taskID, nodeID)
		if config.RetriesAllowed != nil {
			g5Exec(k.Db, "UPDATE kernel_node_state SET retries_allowed=? WHERE task_id=? AND node_id=?", *config.RetriesAllowed, taskID, nodeID)
		}
		if config.ResubmitsAllowed != nil {
			g5Exec(k.Db, "UPDATE kernel_node_state SET resubmits_allowed=? WHERE task_id=? AND node_id=?", *config.ResubmitsAllowed, taskID, nodeID)
		}
		return nil
	})
}

func (k *KernelStore) NoteNodeRebind(taskID, nodeID string) {
	k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		k.ensureNodeState(taskID, nodeID)
		g5Exec(k.Db, "UPDATE kernel_node_state SET rebinds=rebinds+1 WHERE task_id=? AND node_id=?", taskID, nodeID)
		return nil
	})
}

func (k *KernelStore) SetNodeIdle(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=?", taskID, nodeID)
}

func (k *KernelStore) RetireNode(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='retired' WHERE task_id=? AND node_id=?", taskID, nodeID)
}

func (k *KernelStore) ParkNode(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?", taskID, nodeID)
}
