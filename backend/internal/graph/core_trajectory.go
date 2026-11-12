package graph

import (
	"encoding/json"
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

type TrajectoryToolStat struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Ms     int64  `json:"ms"`
	Errors int    `json:"errors"`
}

type TrajectoryTiming struct {
	WallMs  int64 `json:"wallMs"`
	TtftMs  int64 `json:"ttftMs"`
	GenMs   int64 `json:"genMs"`
	ToolMs  int64 `json:"toolMs"`
	OtherMs int64 `json:"otherMs"`
}

type TrajectoryContext struct {
	LastTokens int64 `json:"lastTokens"`
	PeakTokens int64 `json:"peakTokens"`
}

type TrajectoryRequest struct {
	Id            string `json:"id"`
	Model         string `json:"model"`
	At            int64  `json:"at"`
	ContextTokens int64  `json:"contextTokens"`
	Input         int64  `json:"input"`
	Output        int64  `json:"output"`
	CacheRead     int64  `json:"cacheRead"`
	CacheWrite    int64  `json:"cacheWrite"`
	DurationMs    int64  `json:"durationMs"`
}

type TrajectoryEvent struct {
	At     int64  `json:"at"`
	Type   string `json:"type"`
	Text   string `json:"text"`
	Tokens int64  `json:"tokens"`
}

type TrajectoryCommand struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type TrajectoryComposition struct {
	SystemPrompt    int64 `json:"systemPrompt"`
	ToolDefinitions int64 `json:"toolDefinitions"`
	UserMessages    int64 `json:"userMessages"`
	AssistantReply  int64 `json:"assistantReply"`
	ToolCalls       int64 `json:"toolCalls"`
	Injected        int64 `json:"injected"`
	Reasoning       int64 `json:"reasoning"`
}

type TrajectoryFiles struct {
	Read   int `json:"read"`
	Write  int `json:"write"`
	Search int `json:"search"`
	Image  int `json:"image"`
}

type TrajectoryTotals struct {
	Turns        int                  `json:"turns"`
	Requests     int                  `json:"requests"`
	ModelReplies int                  `json:"modelReplies"`
	UserMessages int                  `json:"userMessages"`
	ToolMessages int                  `json:"toolMessages"`
	Compactions  int                  `json:"compactions"`
	ToolCalls    int                  `json:"toolCalls"`
	ToolErrors   int                  `json:"toolErrors"`
	Input        int64                `json:"input"`
	Output       int64                `json:"output"`
	CacheRead    int64                `json:"cacheRead"`
	CacheWrite   int64                `json:"cacheWrite"`
	TotalTokens  int64                `json:"totalTokens"`
	Cost         float64              `json:"cost"`
	DurationMs   int64                `json:"durationMs"`
	CacheHitRate float64              `json:"cacheHitRate"`
	ToolsByName  []TrajectoryToolStat `json:"toolsByName"`
	Timing       TrajectoryTiming     `json:"timing"`
	Context      TrajectoryContext    `json:"context"`
	Commands     []TrajectoryCommand  `json:"commands"`
	Files        TrajectoryFiles      `json:"files"`
}

type ConversationTrajectory struct {
	ConversationId string                `json:"conversationId"`
	TaskId         string                `json:"taskId"`
	Turns          []TrajectoryTurn      `json:"turns"`
	Requests       []TrajectoryRequest   `json:"requests"`
	Events         []TrajectoryEvent     `json:"events"`
	Totals         TrajectoryTotals      `json:"totals"`
	Composition    TrajectoryComposition `json:"composition"`
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
	trajectory.Totals.Requests = len(invocations)
	trajectory.Totals.ToolsByName = trajectoryToolStats(tools)
	for _, message := range messages {
		switch message.Role {
		case "user":
			if message.Kind == "chat" {
				trajectory.Totals.UserMessages++
			}
		case "assistant":
			if message.Kind == "chat" {
				trajectory.Totals.ModelReplies++
			}
		case "tool":
			trajectory.Totals.ToolMessages++
		}
	}
	lastContext, peakContext := int64(0), int64(0)
	for _, invocation := range invocations {
		if invocation.Usage.ContextTokens > 0 {
			lastContext = invocation.Usage.ContextTokens
			if lastContext > peakContext {
				peakContext = lastContext
			}
		}
		if invocation.Usage.FirstTokenMs > 0 {
			trajectory.Totals.Timing.TtftMs += invocation.Usage.FirstTokenMs
		}
		if invocation.DurationMs > 0 {
			generation := invocation.DurationMs - invocation.Usage.FirstTokenMs
			if generation > 0 {
				trajectory.Totals.Timing.GenMs += generation
			}
		}
	}
	trajectory.Totals.Context = TrajectoryContext{LastTokens: lastContext, PeakTokens: peakContext}
	trajectory.Totals.Timing.WallMs = trajectory.Totals.DurationMs
	for _, tool := range tools {
		trajectory.Totals.Timing.ToolMs += tool.Ms
	}
	occupied := trajectory.Totals.Timing.TtftMs + trajectory.Totals.Timing.GenMs + trajectory.Totals.Timing.ToolMs
	if trajectory.Totals.Timing.WallMs > occupied {
		trajectory.Totals.Timing.OtherMs = trajectory.Totals.Timing.WallMs - occupied
	}
	trajectory.Totals.Compactions = int(kernelInt(kernelRow(store.Db, "SELECT COUNT(*) AS count FROM events WHERE task_id=? AND type='session.compacted'", trajectory.TaskId)["count"]))
	trajectory.Requests = trajectoryRequests(invocations)
	trajectory.Events = trajectoryContextEvents(store, trajectory.TaskId)
	trajectory.Totals.Commands = trajectoryCommands(store, conversationId)
	trajectory.Totals.Files = trajectoryFiles(store, trajectory.TaskId)
	trajectory.Composition = trajectoryComposition(store, conversationId, trajectory.TaskId)
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
