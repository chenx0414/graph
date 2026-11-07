package graph

import (
	"encoding/json"
	"strings"
)

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

func (k *KernelStore) NodeUsage(taskID, nodeID string) (used int64, paused bool) {
	row, ok := g5One(k.Db, "SELECT used,paused FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok {
		return 0, false
	}
	return g5Int(row["used"]), g5Int(row["paused"]) != 0
}

func (k *KernelStore) PendingProviderCalls(taskID, nodeID string) []KernelProviderCall {
	rows := g5Query(k.Db, "SELECT id,node_id,execution_id,reserved,state,usage,model,purpose,cost,created_at,settled_at FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown')", taskID, nodeID)
	return k.providerCallsFrom(rows)
}

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

func (k *KernelStore) OpenProviderCall(id, taskID, nodeID, executionID string, reserved float64, model any, purpose string) {
	g5Exec(k.Db, "INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,created_at,model,purpose) VALUES(?,?,?,?,?,?,?,?,?)",
		id, taskID, nodeID, executionID, reserved, "inflight", NowMillis(), model, purpose)
}

func (k *KernelStore) SettleProviderCall(id, state string, usage any, cost any) {
	g5Exec(k.Db, "UPDATE kernel_provider_calls SET state=?,usage=?,cost=?,settled_at=? WHERE id=?", state, usage, cost, NowMillis(), id)
}

func (k *KernelStore) ReconcileProviderCall(id string, usage any, cost any) {
	g5Exec(k.Db, "UPDATE kernel_provider_calls SET state='reconciled',usage=?,cost=?,settled_at=? WHERE id=?", usage, cost, NowMillis(), id)
}

func (k *KernelStore) HasPendingProviderCall(taskID, nodeID string) bool {
	_, ok := g5One(k.Db, "SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown') LIMIT 1", taskID, nodeID)
	return ok
}

func (k *KernelStore) pendingProviderCallDetail(taskID, nodeID string) string {
	calls := k.PendingProviderCalls(taskID, nodeID)
	if len(calls) == 0 {
		return ""
	}
	now := NowMillis()
	parts := make([]string, 0, len(calls))
	for _, call := range calls {
		parts = append(parts, call.Id+" state="+call.State+" execution="+call.ExecutionId+" purpose="+call.Purpose+" openForMs="+itoa(int(now-call.CreatedAt)))
	}
	return " (" + itoa(len(calls)) + ": " + strings.Join(parts, "; ") + ")"
}

func (k *KernelStore) HasUnknownProviderCall(taskID, nodeID string) bool {
	_, ok := g5One(k.Db, "SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state='unknown' LIMIT 1", taskID, nodeID)
	return ok
}

func (k *KernelStore) HasRunningExecution(taskID, nodeID string) bool {
	_, ok := g5One(k.Db, "SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' LIMIT 1", taskID, nodeID)
	return ok
}

func (k *KernelStore) ClearExecutionTokenReservation(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET token_reservation=0 WHERE task_id=? AND node_id=? AND state!='running'", taskID, nodeID)
}

func (k *KernelStore) ProviderCallsOfExecution(executionID string) []KernelProviderCall {
	rows := g5Query(k.Db, "SELECT id,node_id,execution_id,reserved,state,usage,model,purpose,cost,created_at,settled_at FROM kernel_provider_calls WHERE execution_id=?", executionID)
	return k.providerCallsFrom(rows)
}
