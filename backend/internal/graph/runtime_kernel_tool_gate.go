package graph

import (
	"math"
)

func KernelToolGate(kernel *KernelStore, graphID, nodeID string, kind string, closing func() bool) SendGate {
	return SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any {
			if reservation < 0 || reservation != math.Trunc(reservation) || reservation > maxSafeInteger {
				Raise("budget", "Invalid tool reservation")
			}
			execution := kernel.RunningExecution(graphID, nodeID)
			task := kernel.Store.Task(graphID)
			_, paused := kernel.NodeUsage(graphID, nodeID)
			if projectArchived(kernel.Store, task.ProjectID) {
				Raise("paused", "Project is archived")
			}
			phaseClosed := task.Phase == "stopping" || task.Phase == "stopped" || task.Phase == "completed"
			if execution == nil || closing() || task.Paused != 0 || paused || phaseClosed {
				Raise("paused", "Node tool dispatch is closed")
			}
			kernel.Store.Event(graphID, "graph."+kind+".started", map[string]any{"nodeId": nodeID, "executionId": execution.Id, "invocationId": id})
			return send()
		},
		Settle: func(id string, usage *TokenUsage) {
			kernel.Store.Event(graphID, "graph."+kind+".settled", map[string]any{"nodeId": nodeID, "invocationId": id, "usage": usage})
		},
	}
}
