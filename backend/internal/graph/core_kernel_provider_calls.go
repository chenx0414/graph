package graph

import "encoding/json"

func (k *KernelStore) ProviderCalls(taskID string, nodeID ...string) []KernelProviderCall {
	query := "SELECT id,node_id,execution_id,reserved,state,usage,model,purpose,cost,created_at,settled_at FROM kernel_provider_calls WHERE task_id=?"
	args := []any{taskID}
	if len(nodeID) > 0 && nodeID[0] != "" {
		query += " AND node_id=?"
		args = append(args, nodeID[0])
	}
	query += " ORDER BY rowid"
	return k.providerCallsFrom(g5Query(k.Db, query, args...))
}

// providerCallsFrom reads provider call rows.
func (k *KernelStore) providerCallsFrom(rows []map[string]any) []KernelProviderCall {
	out := make([]KernelProviderCall, 0, len(rows))
	for _, row := range rows {
		call := KernelProviderCall{
			Id: g5Str(row["id"]), NodeId: g5Str(row["node_id"]), ExecutionId: g5Str(row["execution_id"]),
			Reserved: g5Int(row["reserved"]), State: g5Str(row["state"]), Purpose: g5Str(row["purpose"]), CreatedAt: g5Int(row["created_at"]),
		}
		if row["usage"] != nil {
			usage := &TokenUsage{}
			if err := json.Unmarshal([]byte(g5Str(row["usage"])), usage); err != nil {
				panic(err)
			}
			call.Usage = usage
		}
		if row["model"] != nil {
			// A row the kernel wrote is always readable; a row that is not
			// leaves the model empty rather than taking the daemon down.
			model := &providerCallModel{}
			if err := json.Unmarshal([]byte(g5Str(row["model"])), model); err == nil {
				call.Model = model
			}
		}
		if row["cost"] != nil {
			call.Cost = g5JSON(row["cost"])
		}
		if row["settled_at"] != nil {
			value := g5Int(row["settled_at"])
			call.SettledAt = &value
		}
		out = append(out, call)
	}
	return out
}

// ListNodes lists admitted nodes of the latest revision.

// NodeUsage is what a node has spent and whether it is paused.
func (k *KernelStore) NodeUsage(taskID, nodeID string) (used int64, paused bool) {
	row, ok := g5One(k.Db, "SELECT used,paused FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok {
		return 0, false
	}
	return g5Int(row["used"]), g5Int(row["paused"]) != 0
}

// PendingProviderCalls are the calls of a node that have not settled yet.
func (k *KernelStore) PendingProviderCalls(taskID, nodeID string) []KernelProviderCall {
	rows := g5Query(k.Db, "SELECT id,node_id,execution_id,reserved,state,usage,model,purpose,cost,created_at,settled_at FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown')", taskID, nodeID)
	return k.providerCallsFrom(rows)
}

// ProviderCall is one provider call of a node.
func (k *KernelStore) ProviderCall(id, taskID, nodeID string) *KernelProviderCall {
	row, ok := g5One(k.Db, "SELECT id,node_id,execution_id,reserved,state,usage,model,purpose,cost,created_at,settled_at FROM kernel_provider_calls WHERE id=? AND task_id=? AND node_id=?", id, taskID, nodeID)
	if !ok {
		return nil
	}
	calls := k.providerCallsFrom([]map[string]any{row})
	if len(calls) == 0 {
		return nil
	}
	return &calls[0]
}

// ProviderCallOfTask is one provider call of a task.
func (k *KernelStore) ProviderCallOfTask(taskID, id string) *KernelProviderCall {
	row, ok := g5One(k.Db, "SELECT id,node_id,execution_id,reserved,state,usage,model,purpose,cost,created_at,settled_at FROM kernel_provider_calls WHERE task_id=? AND id=?", taskID, id)
	if !ok {
		return nil
	}
	calls := k.providerCallsFrom([]map[string]any{row})
	if len(calls) == 0 {
		return nil
	}
	return &calls[0]
}

// OpenProviderCall records a provider call that is about to be sent.
func (k *KernelStore) OpenProviderCall(id, taskID, nodeID, executionID string, reserved float64, model any, purpose string) {
	g5Exec(k.Db, "INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,created_at,model,purpose) VALUES(?,?,?,?,?,?,?,?,?)",
		id, taskID, nodeID, executionID, reserved, "inflight", NowMillis(), model, purpose)
}

// SettleProviderCall records what a provider call cost.
func (k *KernelStore) SettleProviderCall(id, state string, usage any, cost any) {
	g5Exec(k.Db, "UPDATE kernel_provider_calls SET state=?,usage=?,cost=?,settled_at=? WHERE id=?", state, usage, cost, NowMillis(), id)
}

// ReconcileProviderCall records a call whose usage was reconciled by hand.
func (k *KernelStore) ReconcileProviderCall(id string, usage any, cost any) {
	g5Exec(k.Db, "UPDATE kernel_provider_calls SET state='reconciled',usage=?,cost=?,settled_at=? WHERE id=?", usage, cost, NowMillis(), id)
}

// HasPendingProviderCall reports whether a node has a call that has not settled.
func (k *KernelStore) HasPendingProviderCall(taskID, nodeID string) bool {
	_, ok := g5One(k.Db, "SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown') LIMIT 1", taskID, nodeID)
	return ok
}

// HasUnknownProviderCall reports whether a node has usage nobody can account for.
func (k *KernelStore) HasUnknownProviderCall(taskID, nodeID string) bool {
	_, ok := g5One(k.Db, "SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state='unknown' LIMIT 1", taskID, nodeID)
	return ok
}

// HasRunningExecution reports whether a node has an execution that is running.
func (k *KernelStore) HasRunningExecution(taskID, nodeID string) bool {
	_, ok := g5One(k.Db, "SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' LIMIT 1", taskID, nodeID)
	return ok
}

// ClearExecutionTokenReservation releases the hold a node's executions keep.
func (k *KernelStore) ClearExecutionTokenReservation(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET token_reservation=0 WHERE task_id=? AND node_id=? AND state!='running'", taskID, nodeID)
}

// ProviderCallsOfExecution are the provider calls one execution made.
func (k *KernelStore) ProviderCallsOfExecution(executionID string) []KernelProviderCall {
	rows := g5Query(k.Db, "SELECT id,node_id,execution_id,reserved,state,usage,model,purpose,cost,created_at,settled_at FROM kernel_provider_calls WHERE execution_id=?", executionID)
	return k.providerCallsFrom(rows)
}
