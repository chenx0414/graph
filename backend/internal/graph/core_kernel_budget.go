package graph

import (
	"encoding/json"
)

func (k *KernelStore) NodeState(taskID, nodeID string) NodeStateRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok {
		return NodeStateRow{}
	}
	return NodeStateRow{
		Attempts: int(g5Int(row["attempts"])), ResubmitsUsed: int(g5Int(row["resubmits_used"])),
		RetriesAllowed: kernelOptInt(row["retries_allowed"]), ResubmitsAllowed: kernelOptInt(row["resubmits_allowed"]),
		Paused: g5Int(row["paused"]) == 1, Rebinds: int(g5Int(row["rebinds"])),
	}
}

// AuthorizedBudget is the explicit user quota, or nil when unset.
func (k *KernelStore) AuthorizedBudget(taskID, nodeID string) *TokenBudget {
	row, ok := g5One(k.Db, "SELECT authorized_budget FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok || row["authorized_budget"] == nil || g5Str(row["authorized_budget"]) == "" {
		return nil
	}
	budget := &TokenBudget{}
	if err := json.Unmarshal([]byte(g5Str(row["authorized_budget"])), budget); err != nil {
		panic(err)
	}
	return budget
}

// SetAuthorizedBudget records an explicit quota. Nil tokens means unlimited.
func (k *KernelStore) SetAuthorizedBudget(taskID, nodeID string, tokens *int64) {
	phase := k.Store.Task(taskID).Phase
	if phase == "completed" || phase == "stopping" || phase == "stopped" {
		Raise("invalid_graph", "Ended graph cannot change budget")
	}
	definition := k.LatestRevision(taskID)
	if definition == nil {
		Raise("not_found", "Unknown agent node")
	}
	if _, ok := definition.Definition.Nodes[nodeID]; !ok || k.NodeStatus(taskID, nodeID) == "retired" {
		Raise("not_found", "Unknown agent node")
	}
	if tokens != nil && (!isSafeInteger(*tokens) || *tokens <= 0) {
		Raise("invalid_input", "Budget must be a positive integer or null")
	}
	k.ensureNodeState(taskID, nodeID)
	budget := TokenBudget{Unlimited: tokens == nil}
	if tokens != nil {
		budget.Budget = float64(*tokens)
	}
	raw, err := json.Marshal(budget)
	if err != nil {
		panic(err)
	}
	g5Exec(k.Db, "UPDATE kernel_node_state SET authorized_budget=? WHERE task_id=? AND node_id=?", string(raw), taskID, nodeID)
}

// BudgetState reports spent and held tokens against a caller-supplied quota.
func (k *KernelStore) BudgetState(taskID, nodeID string, budget TokenBudget) NodeBudgetState {
	k.ensureNodeState(taskID, nodeID)
	row, _ := g5One(k.Db, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
	return NodeBudgetState{Budget: budget.Budget, Unlimited: budget.Unlimited, Used: float64(g5Int(row["used"])), Reserved: float64(g5Int(row["reserved"]))}
}

// ReserveNodeTokens holds a reservation or refuses the send.
func (k *KernelStore) ReserveNodeTokens(taskID, nodeID string, budget TokenBudget, amount float64, executionID string) {
	if !isSafeInteger(amount) || amount < 0 {
		Raise("invalid_adapter", "A bounded token reservation is required")
	}
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		row, _ := g5One(k.Db, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
		if !budget.Unlimited && float64(g5Int(row["used"]))+float64(g5Int(row["reserved"]))+amount > budget.Budget {
			Raise("budget", "Token budget exhausted for node "+nodeID)
		}
		g5Exec(k.Db, "UPDATE kernel_node_state SET reserved=reserved+? WHERE task_id=? AND node_id=?", int64(amount), taskID, nodeID)
		if executionID != "" {
			g5Exec(k.Db, "UPDATE kernel_executions SET token_reservation=? WHERE id=?", int64(amount), executionID)
		}
		return nil
	})
}

// ReleaseNodeTokens returns a hold.
func (k *KernelStore) ReleaseNodeTokens(taskID, nodeID string, amount float64, executionID string) {
	if !isSafeInteger(amount) || amount < 0 {
		return
	}
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		g5Exec(k.Db, "UPDATE kernel_node_state SET reserved=MAX(0,reserved-?) WHERE task_id=? AND node_id=?", int64(amount), taskID, nodeID)
		if executionID != "" {
			g5Exec(k.Db, "UPDATE kernel_executions SET token_reservation=0 WHERE id=?", executionID)
		}
		return nil
	})
}

// PauseNode holds a node without dropping its queue.
func (k *KernelStore) PauseNode(taskID, nodeID string) {
	k.ensureNodeState(taskID, nodeID)
	g5Exec(k.Db, "UPDATE kernel_node_state SET paused=1 WHERE task_id=? AND node_id=?", taskID, nodeID)
	k.Store.Event(taskID, "graph.node.paused", map[string]any{"nodeId": nodeID})
}

// ResumeNode clears a node pause.
func (k *KernelStore) ResumeNode(taskID, nodeID string) {
	k.ensureNodeState(taskID, nodeID)
	g5Exec(k.Db, "UPDATE kernel_node_state SET paused=0 WHERE task_id=? AND node_id=?", taskID, nodeID)
	k.Store.Event(taskID, "graph.node.resumed", map[string]any{"nodeId": nodeID})
}

// ProviderCalls lists actual sends for a graph, optionally one node.
func (k *KernelStore) ReconcileNodeUsage(taskID, nodeID, decision string) {
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		row, _ := g5One(k.Db, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
		if decision == "record" {
			g5Exec(k.Db, "UPDATE kernel_node_state SET used=used+reserved,reserved=0,last_committed=used+reserved WHERE task_id=? AND node_id=?", taskID, nodeID)
		} else {
			g5Exec(k.Db, "UPDATE kernel_node_state SET reserved=0 WHERE task_id=? AND node_id=?", taskID, nodeID)
		}
		g5Exec(k.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status='blocked'", taskID, nodeID)
		k.Store.Event(taskID, "graph.node.usage-reconciled", map[string]any{"nodeId": nodeID, "decision": decision, "held": g5Int(row["reserved"])})
		return nil
	})
}

// BlockNode parks a node without counting a failed attempt.
func (k *KernelStore) RequestBudget(taskID, nodeID, executionID, reason string) {
	execution := k.Execution(executionID)
	if execution == nil || execution.TaskId != taskID || execution.NodeId != nodeID || execution.TokenBudget == nil || execution.TokenBudget.Unlimited {
		return
	}
	k.Store.Transaction(func() any {
		if _, exists := g5One(k.Db, "SELECT 1 FROM questions WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'", taskID, nodeID); exists {
			return nil
		}
		state := k.BudgetState(taskID, nodeID, *execution.TokenBudget)
		InsertQuestion(k.Store, QuestionInput{TaskId: taskID, NodeId: nodeID, Kind: "budget", Data: map[string]any{
			"prompt":      "Token quota is insufficient. Authorize an increment; main can then explicitly retry unsubmitted work.",
			"executionId": executionID, "reason": reason, "budget": state.Budget, "used": state.Used, "reserved": state.Reserved,
		}})
		return nil
	})
}

// CommitNodeUsage adds a reported amount to what the node already spent.
//
// The node budget has one write rule: a reported amount is added to the
// spend, never written over it. The provider gate settles one call at a
// time and the node executor settles a whole turn, and both come through
// here so the two of them cannot disagree about what a node has used.
func (k *KernelStore) CommitNodeUsage(taskID, nodeID string, amount int64) {
	if !isSafeInteger(amount) || amount < 0 {
		return
	}
	k.ensureNodeState(taskID, nodeID)
	g5Exec(k.Db, "UPDATE kernel_node_state SET used=used+?,last_committed=used+? WHERE task_id=? AND node_id=?", amount, amount, taskID, nodeID)
}

// SettleNodeReservation releases the hold a node keeps on its budget once no
// provider call and no execution of that node is still waiting.
func (k *KernelStore) SettleNodeReservation(taskID, nodeID string) {
	k.ensureNodeState(taskID, nodeID)
	g5Exec(k.Db, "UPDATE kernel_node_state SET reserved=0 WHERE task_id=? AND node_id=?", taskID, nodeID)
}
