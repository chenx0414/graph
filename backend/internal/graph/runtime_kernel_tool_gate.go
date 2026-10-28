package graph

import (
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
			execution := kernel.RunningExecution(graphID, nodeID)
			task := kernel.Store.Task(graphID)
			used, paused := kernel.NodeUsage(graphID, nodeID)
			if projectArchived(kernel.Store, task.ProjectID) {
				Raise("paused", "Project is archived")
			}
			phaseClosed := task.Phase == "stopping" || task.Phase == "stopped" || task.Phase == "completed"
			if execution == nil || closing() || task.Paused != 0 || paused || phaseClosed {
				Raise("paused", "Node tool dispatch is closed")
			}
			unlimited := false
			budget := float64(0)
			hasBudget := false
			if execution.TokenBudget != nil {
				hasBudget = true
				budget = execution.TokenBudget.Budget
				unlimited = execution.TokenBudget.Unlimited
			}
			reserved := 0
			unknown := false
			for _, call := range kernel.PendingProviderCalls(graphID, nodeID) {
				reserved += int(call.Reserved)
				if call.State == "unknown" {
					unknown = true
				}
			}
			if hasBudget && !unlimited && (float64(used) >= budget || float64(used)+reservation+float64(reserved) > budget) {
				Raise("budget", "Node budget is exhausted")
			}
			if unknown && !unlimited {
				Raise("budget", "Node usage must be reconciled before tool dispatch")
			}
			kernel.Store.Event(graphID, "graph."+kind+".started", map[string]any{"nodeId": nodeID, "executionId": execution.Id, "invocationId": id})
			return send()
		},
		Settle: func(id string, usage *TokenUsage) {
			kernel.Store.Event(graphID, "graph."+kind+".settled", map[string]any{"nodeId": nodeID, "invocationId": id, "usage": usage})
		},
	}
}
