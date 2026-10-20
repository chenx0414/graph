package graph

import (
	"database/sql"
	"math"
)

// KernelToolGate admits host tools against the running execution.
// Tool usage is distinct from provider usage.
func KernelToolGate(kernel *KernelStore, graphID, nodeID string, kind string, closing func() bool) SendGate {
	return SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any {
			if reservation < 0 || reservation != math.Trunc(reservation) || reservation > maxSafeInteger {
				Raise("budget", "Invalid tool reservation")
			}
			var executionID string
			err := kernel.Db.QueryRow("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running'", graphID, nodeID).Scan(&executionID)
			if err == sql.ErrNoRows {
				executionID = ""
				err = nil
			}
			if err != nil {
				panic(err)
			}
			task := kernel.Store.Task(graphID)
			var used, paused int
			err = kernel.Db.QueryRow("SELECT used,paused FROM kernel_node_state WHERE task_id=? AND node_id=?", graphID, nodeID).Scan(&used, &paused)
			if err != nil {
				panic(err)
			}
			phaseClosed := task.Phase == "stopping" || task.Phase == "stopped" || task.Phase == "completed"
			if executionID == "" || closing() || task.Paused != 0 || paused != 0 || phaseClosed {
				Raise("paused", "Node tool dispatch is closed")
			}
			execution := kernel.Execution(executionID)
			unlimited := false
			budget := float64(0)
			hasBudget := false
			if execution != nil && execution.TokenBudget != nil {
				hasBudget = true
				budget = execution.TokenBudget.Budget
				unlimited = execution.TokenBudget.Unlimited
			}
			rows, err := kernel.Db.Query("SELECT state,reserved FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown')", graphID, nodeID)
			if err != nil {
				panic(err)
			}
			defer rows.Close()
			reserved := 0
			unknown := false
			for rows.Next() {
				var state string
				var amount int
				if err := rows.Scan(&state, &amount); err != nil {
					panic(err)
				}
				reserved += amount
				if state == "unknown" {
					unknown = true
				}
			}
			if err := rows.Err(); err != nil {
				panic(err)
			}
			if hasBudget && !unlimited && (float64(used) >= budget || float64(used)+reservation+float64(reserved) > budget) {
				Raise("budget", "Node budget is exhausted")
			}
			if unknown && !unlimited {
				Raise("budget", "Node usage must be reconciled before tool dispatch")
			}
			kernel.Store.Event(graphID, "graph."+kind+".started", map[string]any{"nodeId": nodeID, "executionId": executionID, "invocationId": id})
			return send()
		},
		Settle: func(id string, usage *TokenUsage) {
			kernel.Store.Event(graphID, "graph."+kind+".settled", map[string]any{"nodeId": nodeID, "invocationId": id, "usage": usage})
		},
	}
}
