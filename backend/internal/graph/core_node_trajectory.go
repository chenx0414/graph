package graph

import (
	"encoding/json"
	"sort"
)

func trajectoryNodeMessages(store *TaskStore, taskId, nodeId string) []trajectoryMessage {
	rows := kernelRows(store.Db, `SELECT id,role,kind,COALESCE(operation_id,'') AS operation_id,created_at
		FROM node_entries WHERE task_id=? AND node_id=? ORDER BY seq`, taskId, nodeId)
	messages := make([]trajectoryMessage, 0, len(rows))
	for _, row := range rows {
		message := trajectoryMessage{
			Id:          kernelString(row["id"]),
			Role:        kernelString(row["role"]),
			Kind:        kernelString(row["kind"]),
			OperationId: kernelString(row["operation_id"]),
			CreatedAt:   kernelInt(row["created_at"]),
		}
		if (message.Role == "user" || message.Role == "assistant") && (message.Kind == "message" || message.Kind == "chat") {
			message.Kind = "chat"
		}
		messages = append(messages, message)
	}
	return messages
}

func trajectoryNodeInvocations(store *TaskStore, taskId, nodeId string) []trajectoryInvocation {
	invocations := trajectoryNodeOperationInvocations(store, taskId, nodeId)
	if graphTableExists(store.Db, "kernel_provider_calls") {
		invocations = append(invocations, trajectoryNodeKernelInvocations(store, taskId, nodeId)...)
	}
	sort.SliceStable(invocations, func(left, right int) bool {
		return invocations[left].Dispatched < invocations[right].Dispatched
	})
	return invocations
}

func trajectoryNodeOperationInvocations(store *TaskStore, taskId, nodeId string) []trajectoryInvocation {
	rows := kernelRows(store.Db, `SELECT i.id,i.operation_id,i.model,i.purpose,i.usage,i.cost,i.composition,
		COALESCE(i.dispatched_at,0) AS dispatched_at,COALESCE(i.settled_at,0) AS settled_at
		FROM invocations i JOIN operations o ON o.id=i.operation_id
		WHERE o.task_id=? AND o.node_id=? ORDER BY i.rowid`, taskId, nodeId)
	invocations := make([]trajectoryInvocation, 0, len(rows))
	for _, row := range rows {
		invocation := trajectoryInvocation{
			OperationId: kernelString(row["operation_id"]),
			TrajectoryInvocation: TrajectoryInvocation{
				Id:         kernelString(row["id"]),
				Model:      kernelString(row["model"]),
				Purpose:    kernelString(row["purpose"]),
				Dispatched: kernelInt(row["dispatched_at"]),
				Settled:    kernelInt(row["settled_at"]),
				Cost:       trajectoryCost(row["cost"]),
			},
		}
		if invocation.Settled > invocation.Dispatched {
			invocation.DurationMs = invocation.Settled - invocation.Dispatched
		}
		if recorded, ok := row["usage"].(string); ok && recorded != "" {
			var usage TokenUsage
			if json.Unmarshal([]byte(recorded), &usage) == nil {
				invocation.Usage = trajectoryUsage(usage)
			}
		}
		if recorded, ok := row["composition"].(string); ok && recorded != "" {
			var composition TrajectoryComposition
			if json.Unmarshal([]byte(recorded), &composition) == nil {
				invocation.Composition = &composition
			}
		}
		invocations = append(invocations, invocation)
	}
	return invocations
}

func trajectoryNodeKernelInvocations(store *TaskStore, taskId, nodeId string) []trajectoryInvocation {
	rows := kernelRows(store.Db, `SELECT id,execution_id,COALESCE(model,'') AS model,purpose,usage,cost,
		created_at,COALESCE(settled_at,0) AS settled_at
		FROM kernel_provider_calls WHERE task_id=? AND node_id=? ORDER BY created_at`, taskId, nodeId)
	invocations := make([]trajectoryInvocation, 0, len(rows))
	for _, row := range rows {
		invocation := trajectoryInvocation{
			OperationId: kernelString(row["execution_id"]),
			TrajectoryInvocation: TrajectoryInvocation{
				Id:         kernelString(row["id"]),
				Model:      kernelString(row["model"]),
				Purpose:    kernelString(row["purpose"]),
				Dispatched: kernelInt(row["created_at"]),
				Settled:    kernelInt(row["settled_at"]),
				Cost:       trajectoryCost(row["cost"]),
			},
		}
		if invocation.Settled > invocation.Dispatched {
			invocation.DurationMs = invocation.Settled - invocation.Dispatched
		}
		if recorded, ok := row["usage"].(string); ok && recorded != "" {
			var usage TokenUsage
			if json.Unmarshal([]byte(recorded), &usage) == nil {
				invocation.Usage = trajectoryUsage(usage)
			}
		}
		invocations = append(invocations, invocation)
	}
	return invocations
}

func trajectoryNodeTools(store *TaskStore, taskId, nodeId string) []TrajectoryTool {
	rows := kernelRows(store.Db, `SELECT tool,ms,is_error,created_at FROM tool_calls
		WHERE task_id=? AND node_id=? ORDER BY created_at`, taskId, nodeId)
	tools := make([]TrajectoryTool, 0, len(rows))
	for _, row := range rows {
		tools = append(tools, TrajectoryTool{
			Name:    kernelString(row["tool"]),
			Ms:      kernelInt(row["ms"]),
			IsError: kernelInt(row["is_error"]) != 0,
			At:      kernelInt(row["created_at"]),
		})
	}
	return tools
}

func trajectoryNodeAgents(store *TaskStore, taskId, nodeId string, invocations []trajectoryInvocation) []TrajectoryAgent {
	role := ""
	if graphTableExists(store.Db, "agents") {
		if row := kernelRow(store.Db, `SELECT role FROM agents WHERE task_id=? AND node_id=? LIMIT 1`, taskId, nodeId); row != nil {
			role = kernelString(row["role"])
		}
	}
	for _, source := range []struct {
		table  string
		column string
	}{
		{"nodes", "id"},
		{"kernel_nodes", "node_id"},
	} {
		if role != "" {
			break
		}
		if !graphTableExists(store.Db, source.table) {
			continue
		}
		row := kernelRow(store.Db, `SELECT spec FROM `+source.table+` WHERE task_id=? AND `+source.column+`=?`, taskId, nodeId)
		if row == nil {
			continue
		}
		var spec map[string]any
		if json.Unmarshal([]byte(kernelString(row["spec"])), &spec) == nil {
			role = kernelString(spec["role"])
		}
	}
	agent := TrajectoryAgent{TaskId: taskId, NodeId: nodeId, Role: role}
	for _, invocation := range invocations {
		agent.Requests++
		agent.Tokens += invocation.Usage.Total
		agent.Cost += invocation.Cost
		if invocation.Model != "" {
			agent.Model = invocation.Model
		}
	}
	return []TrajectoryAgent{agent}
}

func BuildNodeTrajectory(store *TaskStore, taskId, nodeId string) *ConversationTrajectory {
	trajectory := &ConversationTrajectory{TaskId: taskId, Turns: []TrajectoryTurn{}}
	messages := trajectoryNodeMessages(store, taskId, nodeId)
	invocations := trajectoryNodeInvocations(store, taskId, nodeId)
	tools := trajectoryNodeTools(store, taskId, nodeId)
	turns, totals := trajectoryTurnsAndTotals(messages, invocations, tools)
	trajectory.Turns = turns
	trajectory.Totals = totals
	trajectory.Totals.Requests = len(invocations)
	trajectory.Totals.ToolsByName = trajectoryToolStats(tools)
	trajectory.Requests = trajectoryRequests(invocations)
	trajectory.Agents = trajectoryNodeAgents(store, taskId, nodeId, invocations)
	return trajectory
}
