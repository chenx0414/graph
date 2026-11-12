package graph

import (
	"encoding/json"
	"strings"
)

type TrajectoryUsage struct {
	Input         int64 `json:"input"`
	Output        int64 `json:"output"`
	CacheRead     int64 `json:"cacheRead"`
	CacheWrite    int64 `json:"cacheWrite"`
	Total         int64 `json:"total"`
	ContextTokens int64 `json:"contextTokens,omitempty"`
	FirstTokenMs  int64 `json:"firstTokenMs,omitempty"`
	DurationMs    int64 `json:"durationMs,omitempty"`
}

type TrajectoryTool struct {
	Name    string `json:"name"`
	Ms      int64  `json:"ms"`
	IsError bool   `json:"isError"`
	At      int64  `json:"at"`
}

type TrajectoryInvocation struct {
	Id         string          `json:"id"`
	Model      string          `json:"model"`
	Purpose    string          `json:"purpose"`
	Dispatched int64           `json:"dispatchedAt"`
	Settled    int64           `json:"settledAt"`
	DurationMs int64           `json:"durationMs"`
	Usage      TrajectoryUsage `json:"usage"`
	Cost       float64         `json:"cost"`
}

type TrajectoryTurn struct {
	Id           string                 `json:"id"`
	Index        int                    `json:"index"`
	StartedAt    int64                  `json:"startedAt"`
	EndedAt      int64                  `json:"endedAt"`
	DurationMs   int64                  `json:"durationMs"`
	Status       string                 `json:"status"`
	Model        string                 `json:"model,omitempty"`
	Usage        TrajectoryUsage        `json:"usage"`
	Cost         float64                `json:"cost"`
	CacheHitRate float64                `json:"cacheHitRate"`
	ToolCalls    []TrajectoryTool       `json:"toolCalls"`
	Invocations  []TrajectoryInvocation `json:"invocations"`
}

type TrajectoryTotals struct {
	Turns        int     `json:"turns"`
	ToolCalls    int     `json:"toolCalls"`
	ToolErrors   int     `json:"toolErrors"`
	Input        int64   `json:"input"`
	Output       int64   `json:"output"`
	CacheRead    int64   `json:"cacheRead"`
	CacheWrite   int64   `json:"cacheWrite"`
	TotalTokens  int64   `json:"totalTokens"`
	Cost         float64 `json:"cost"`
	DurationMs   int64   `json:"durationMs"`
	CacheHitRate float64 `json:"cacheHitRate"`
}

type ConversationTrajectory struct {
	ConversationId string           `json:"conversationId"`
	TaskId         string           `json:"taskId"`
	Turns          []TrajectoryTurn `json:"turns"`
	Totals         TrajectoryTotals `json:"totals"`
}

type trajectoryMessage struct {
	Id          string
	Role        string
	Kind        string
	State       string
	OperationId string
	CreatedAt   int64
}

type trajectoryInvocation struct {
	TrajectoryInvocation
	OperationId string
}

func BuildConversationTrajectory(store *TaskStore, conversationId string) *ConversationTrajectory {
	conversation := kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE id=?", conversationId)
	trajectory := &ConversationTrajectory{ConversationId: conversationId, Turns: []TrajectoryTurn{}}
	if conversation == nil {
		return trajectory
	}
	trajectory.TaskId = kernelString(conversation["anchor_task_id"])
	messages := trajectoryMessages(store, conversationId)
	invocations := trajectoryInvocations(store, trajectory.TaskId)
	tools := trajectoryTools(store, trajectory.TaskId)
	turns := []TrajectoryTurn{}
	current := -1
	for _, message := range messages {
		if message.Role == "user" && message.Kind == "chat" {
			turns = append(turns, TrajectoryTurn{Id: message.Id, Index: len(turns) + 1, StartedAt: message.CreatedAt, Status: "done",
				ToolCalls: []TrajectoryTool{}, Invocations: []TrajectoryInvocation{}})
			current = len(turns) - 1
			continue
		}
		if current < 0 {
			continue
		}
		if message.CreatedAt > turns[current].EndedAt {
			turns[current].EndedAt = message.CreatedAt
		}
		if message.State == string(MessageStateRunning) || message.State == "pending" || message.State == "queued" {
			turns[current].Status = "running"
		}
	}
	for index := range turns {
		end := turns[index].EndedAt
		next := int64(0)
		if index+1 < len(turns) {
			next = turns[index+1].StartedAt
		}
		for _, invocation := range invocations {
			if invocation.Dispatched < turns[index].StartedAt {
				continue
			}
			if next > 0 && invocation.Dispatched >= next {
				continue
			}
			turns[index].Invocations = append(turns[index].Invocations, invocation.TrajectoryInvocation)
			turns[index].Usage = addTrajectoryUsage(turns[index].Usage, invocation.Usage)
			if invocation.Usage.ContextTokens > 0 {
				turns[index].Usage.ContextTokens = invocation.Usage.ContextTokens
			}
			if invocation.Usage.FirstTokenMs > 0 && turns[index].Usage.FirstTokenMs == 0 {
				turns[index].Usage.FirstTokenMs = invocation.Usage.FirstTokenMs
			}
			turns[index].Cost += invocation.Cost
			turns[index].Model = invocation.Model
			if invocation.Settled > end {
				end = invocation.Settled
			}
		}
		for _, tool := range tools {
			if tool.At < turns[index].StartedAt {
				continue
			}
			if next > 0 && tool.At >= next {
				continue
			}
			turns[index].ToolCalls = append(turns[index].ToolCalls, tool)
		}
		if turns[index].Status == "done" && end > 0 {
			turns[index].EndedAt = end
		}
		if turns[index].EndedAt > turns[index].StartedAt {
			turns[index].DurationMs = turns[index].EndedAt - turns[index].StartedAt
		}
		turns[index].CacheHitRate = trajectoryCacheHitRate(turns[index].Usage)
	}
	trajectory.Turns = turns
	trajectory.Totals = trajectoryTotals(turns)
	return trajectory
}

func SaveConversationTrajectory(store *TaskStore, conversationId string) {
	trajectory := BuildConversationTrajectory(store, conversationId)
	if trajectory.TaskId == "" {
		return
	}
	payload, err := json.Marshal(trajectory)
	if err != nil {
		return
	}
	if _, err := store.DB.Exec(`INSERT INTO trajectories(conversation_id,task_id,updated_at,payload) VALUES(?,?,?,?)
		ON CONFLICT(conversation_id) DO UPDATE SET task_id=excluded.task_id, updated_at=excluded.updated_at, payload=excluded.payload`,
		conversationId, trajectory.TaskId, NowMillis(), string(payload)); err != nil {
		panic(err)
	}
}

func trajectoryMessages(store *TaskStore, conversationId string) []trajectoryMessage {
	rows := kernelRows(store.Db, `SELECT id,role,kind,state,COALESCE(operation_id,'') AS operation_id,created_at
		FROM messages WHERE conversation_id=? ORDER BY seq`, conversationId)
	messages := make([]trajectoryMessage, 0, len(rows))
	for _, row := range rows {
		messages = append(messages, trajectoryMessage{
			Id:          kernelString(row["id"]),
			Role:        kernelString(row["role"]),
			Kind:        kernelString(row["kind"]),
			State:       kernelString(row["state"]),
			OperationId: kernelString(row["operation_id"]),
			CreatedAt:   kernelInt(row["created_at"]),
		})
	}
	return messages
}

func trajectoryInvocations(store *TaskStore, taskId string) []trajectoryInvocation {
	rows := kernelRows(store.Db, `SELECT i.id,i.operation_id,i.model,i.purpose,i.usage,i.cost,
		COALESCE(i.dispatched_at,0) AS dispatched_at,COALESCE(i.settled_at,0) AS settled_at
		FROM invocations i JOIN operations o ON o.id=i.operation_id
		WHERE o.task_id=? ORDER BY i.rowid`, taskId)
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
		invocations = append(invocations, invocation)
	}
	return invocations
}

func trajectoryTools(store *TaskStore, taskId string) []TrajectoryTool {
	rows := kernelRows(store.Db, `SELECT tool,ms,is_error,created_at FROM tool_calls WHERE task_id=? ORDER BY created_at`, taskId)
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

func trajectoryUsage(usage TokenUsage) TrajectoryUsage {
	value := TrajectoryUsage{
		Input:      usage.Input,
		Output:     usage.Output,
		CacheRead:  usage.CacheRead,
		CacheWrite: usage.CacheWrite,
		Total:      usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite,
	}
	if usage.ContextTokens != nil {
		value.ContextTokens = *usage.ContextTokens
	}
	if usage.FirstTokenMs != nil {
		value.FirstTokenMs = *usage.FirstTokenMs
	}
	if usage.DurationMs != nil {
		value.DurationMs = *usage.DurationMs
	}
	return value
}

func addTrajectoryUsage(base, extra TrajectoryUsage) TrajectoryUsage {
	return TrajectoryUsage{
		Input:      base.Input + extra.Input,
		Output:     base.Output + extra.Output,
		CacheRead:  base.CacheRead + extra.CacheRead,
		CacheWrite: base.CacheWrite + extra.CacheWrite,
		Total:      base.Total + extra.Total,
	}
}

func trajectoryCacheHitRate(usage TrajectoryUsage) float64 {
	denominator := usage.Input + usage.CacheRead
	if denominator == 0 {
		return 0
	}
	return float64(usage.CacheRead) / float64(denominator)
}

func trajectoryTotals(turns []TrajectoryTurn) TrajectoryTotals {
	totals := TrajectoryTotals{Turns: len(turns)}
	for _, turn := range turns {
		totals.ToolCalls += len(turn.ToolCalls)
		for _, tool := range turn.ToolCalls {
			if tool.IsError {
				totals.ToolErrors++
			}
		}
		totals.Input += turn.Usage.Input
		totals.Output += turn.Usage.Output
		totals.CacheRead += turn.Usage.CacheRead
		totals.CacheWrite += turn.Usage.CacheWrite
		totals.TotalTokens += turn.Usage.Total
		totals.Cost += turn.Cost
		totals.DurationMs += turn.DurationMs
	}
	totals.CacheHitRate = trajectoryCacheHitRate(TrajectoryUsage{Input: totals.Input, CacheRead: totals.CacheRead})
	return totals
}

func trajectoryCost(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case float64:
		return typed
	case int64:
		return float64(typed)
	case string:
		return trajectoryCostJSON([]byte(typed))
	case []byte:
		return trajectoryCostJSON(typed)
	}
	return 0
}

func trajectoryCostJSON(payload []byte) float64 {
	var decoded any
	if json.Unmarshal(payload, &decoded) != nil {
		return 0
	}
	switch typed := decoded.(type) {
	case float64:
		return typed
	case map[string]any:
		for _, key := range []string{"total", "amount", "usd", "cost"} {
			if value, ok := typed[key]; ok {
				if amount := trajectoryCost(value); amount > 0 {
					return amount
				}
			}
		}
		sum := 0.0
		for key, value := range typed {
			if strings.TrimSpace(key) == "" {
				continue
			}
			sum += trajectoryCost(value)
		}
		return sum
	}
	return 0
}
