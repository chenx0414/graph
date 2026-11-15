package graph

import ()

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
	Id            string                 `json:"id"`
	Composition   *TrajectoryComposition `json:"composition,omitempty"`
	Model         string                 `json:"model"`
	At            int64                  `json:"at"`
	ContextTokens int64                  `json:"contextTokens"`
	Input         int64                  `json:"input"`
	Output        int64                  `json:"output"`
	CacheRead     int64                  `json:"cacheRead"`
	CacheWrite    int64                  `json:"cacheWrite"`
	DurationMs    int64                  `json:"durationMs"`
}

type TrajectoryEvent struct {
	At     int64  `json:"at"`
	Type   string `json:"type"`
	Text   string `json:"text"`
	Tokens int64  `json:"tokens"`
}

type TrajectoryCommand struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Errors int    `json:"errors"`
}

type TrajectoryPath struct {
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

type TrajectoryAgent struct {
	TaskId   string  `json:"taskId"`
	NodeId   string  `json:"nodeId"`
	Role     string  `json:"role"`
	Instance string  `json:"instance"`
	Model    string  `json:"model"`
	Requests int     `json:"requests"`
	Tokens   int64   `json:"tokens"`
	Cost     float64 `json:"cost"`
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
	Paths        []TrajectoryPath     `json:"paths"`
	Files        TrajectoryFiles      `json:"files"`
}

type ConversationTrajectory struct {
	ConversationId string                `json:"conversationId"`
	TaskId         string                `json:"taskId"`
	Turns          []TrajectoryTurn      `json:"turns"`
	Requests       []TrajectoryRequest   `json:"requests"`
	RequestOffset  int                   `json:"requestOffset,omitempty"`
	Events         []TrajectoryEvent     `json:"events"`
	Totals         TrajectoryTotals      `json:"totals"`
	Composition    TrajectoryComposition `json:"composition"`
	Agents         []TrajectoryAgent     `json:"agents"`
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
	Composition *TrajectoryComposition
}

func trajectoryTurnsAndTotals(messages []trajectoryMessage, invocations []trajectoryInvocation, tools []TrajectoryTool) ([]TrajectoryTurn, TrajectoryTotals) {
	trajectory := &ConversationTrajectory{Turns: []TrajectoryTurn{}}
	turns := []TrajectoryTurn{}
	turnOperations := []map[string]bool{}
	current := -1
	for _, message := range messages {
		if message.Role == "user" && message.Kind == "chat" {
			turns = append(turns, TrajectoryTurn{Id: message.Id, Index: len(turns) + 1, StartedAt: message.CreatedAt, Status: "done",
				ToolCalls: []TrajectoryTool{}, Invocations: []TrajectoryInvocation{}})
			turnOperations = append(turnOperations, map[string]bool{})
			current = len(turns) - 1
			continue
		}
		if current < 0 {
			continue
		}
		if message.OperationId != "" {
			turnOperations[current][message.OperationId] = true
		}
		if message.CreatedAt > turns[current].EndedAt {
			turns[current].EndedAt = message.CreatedAt
		}
		if message.State == string(MessageStateRunning) || message.State == "pending" || message.State == "queued" {
			turns[current].Status = "running"
		}
	}
	operationTurn := map[string]int{}
	for index, operations := range turnOperations {
		for operationId := range operations {
			if _, ok := operationTurn[operationId]; !ok {
				operationTurn[operationId] = index
			}
		}
	}
	used := make([]bool, len(invocations))
	addInvocation := func(index int, invocation trajectoryInvocation, extendEnd bool) {
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
		if extendEnd && invocation.Settled > turns[index].EndedAt {
			turns[index].EndedAt = invocation.Settled
		}
	}
	for index := range turns {
		next := int64(0)
		if index+1 < len(turns) {
			next = turns[index+1].StartedAt
		}
		for position := range invocations {
			if used[position] {
				continue
			}
			if owner, ok := operationTurn[invocations[position].OperationId]; !ok || owner != index {
				continue
			}
			used[position] = true
			addInvocation(index, invocations[position], true)
		}
		for position := range invocations {
			if used[position] {
				continue
			}
			invocation := invocations[position]
			if invocation.Dispatched < turns[index].StartedAt {
				continue
			}
			if next > 0 && invocation.Dispatched >= next {
				continue
			}
			used[position] = true
			addInvocation(index, invocation, true)
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
		if turns[index].EndedAt > turns[index].StartedAt {
			turns[index].DurationMs = turns[index].EndedAt - turns[index].StartedAt
		}
		turns[index].CacheHitRate = trajectoryCacheHitRate(turns[index].Usage)
	}
	if len(turns) > 0 {
		last := len(turns) - 1
		for position := range invocations {
			if used[position] {
				continue
			}
			addInvocation(last, invocations[position], false)
		}
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
	return turns, trajectory.Totals
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
	turns, totals := trajectoryTurnsAndTotals(messages, invocations, tools)
	trajectory.Turns = turns
	trajectory.Totals = totals
	trajectory.Totals.Compactions = int(kernelInt(kernelRow(store.Db, "SELECT COUNT(*) AS count FROM events WHERE task_id=? AND type='session.compacted'", trajectory.TaskId)["count"]))
	trajectory.Requests = trajectoryRequests(invocations)
	trajectory.Events = trajectoryContextEvents(store, trajectory.TaskId)
	targets, toolErrors, _ := trajectoryToolEvents(store, trajectory.TaskId)
	trajectory.Totals.Commands = trajectoryCommands(store, conversationId, toolErrors)
	trajectory.Totals.Paths = trajectoryPaths(targets)
	trajectory.Totals.Files = trajectoryFiles(store, trajectory.TaskId)
	trajectory.Composition = trajectoryComposition(store, conversationId, trajectory.TaskId)
	if len(trajectory.Requests) > 0 && trajectory.Requests[len(trajectory.Requests)-1].Composition == nil {
		composition := trajectory.Composition
		trajectory.Requests[len(trajectory.Requests)-1].Composition = &composition
	}
	trajectory.Agents = trajectoryAgents(store, conversationId, trajectory.TaskId)
	return trajectory
}

func SaveConversationTrajectory(store *TaskStore, conversationId string) {
	StoreConversationTrajectory(store, conversationId, BuildConversationTrajectory(store, conversationId))
}
