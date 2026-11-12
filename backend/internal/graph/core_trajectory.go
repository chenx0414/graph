package graph

import (
	"encoding/json"
	"sort"
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
	ConversationId string              `json:"conversationId"`
	TaskId         string              `json:"taskId"`
	Turns          []TrajectoryTurn    `json:"turns"`
	Requests       []TrajectoryRequest `json:"requests"`
	Events         []TrajectoryEvent   `json:"events"`
	Totals         TrajectoryTotals    `json:"totals"`
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

func trajectoryRequests(invocations []trajectoryInvocation) []TrajectoryRequest {
	requests := make([]TrajectoryRequest, 0, len(invocations))
	for _, invocation := range invocations {
		requests = append(requests, TrajectoryRequest{
			Id:            invocation.Id,
			Model:         invocation.Model,
			At:            invocation.Dispatched,
			ContextTokens: invocation.Usage.ContextTokens,
			Input:         invocation.Usage.Input,
			Output:        invocation.Usage.Output,
			CacheRead:     invocation.Usage.CacheRead,
			CacheWrite:    invocation.Usage.CacheWrite,
			DurationMs:    invocation.DurationMs,
		})
	}
	return requests
}

func trajectoryContextEvents(store *TaskStore, taskId string) []TrajectoryEvent {
	rows := kernelRows(store.Db, `SELECT timestamp,type,data FROM events
		WHERE task_id=? AND type IN ('session.compacted','session.compaction_started','session.compaction_failed','session.compaction_skipped','operation.usage_reconciled')
		ORDER BY cursor DESC LIMIT 50`, taskId)
	events := make([]TrajectoryEvent, 0, len(rows))
	for _, row := range rows {
		event := TrajectoryEvent{At: kernelInt(row["timestamp"]), Type: kernelString(row["type"])}
		var data map[string]any
		if json.Unmarshal([]byte(kernelString(row["data"])), &data) == nil {
			if tokens, ok := data["tokensAfter"]; ok {
				event.Tokens = kernelInt(tokens)
			}
			if tokens, ok := data["tokensBefore"]; ok && event.Tokens == 0 {
				event.Tokens = kernelInt(tokens)
			}
			if reason, ok := data["reason"].(string); ok {
				event.Text = reason
			}
			if failure, ok := data["error"].(string); ok {
				event.Text = failure
			}
		}
		events = append(events, event)
	}
	return events
}

func trajectoryCommands(store *TaskStore, conversationId string) []TrajectoryCommand {
	rows := kernelRows(store.Db, `SELECT text FROM messages WHERE conversation_id=? AND role='tool' AND kind='call' ORDER BY seq`, conversationId)
	counts := map[string]int{}
	order := []string{}
	for _, row := range rows {
		text := kernelString(row["text"])
		if !strings.HasPrefix(text, "bash:") {
			continue
		}
		for _, command := range trajectoryCommandSegments(strings.TrimSpace(strings.TrimPrefix(text, "bash:"))) {
			if counts[command] == 0 {
				order = append(order, command)
			}
			counts[command]++
		}
	}
	commands := make([]TrajectoryCommand, 0, len(order))
	for _, name := range order {
		commands = append(commands, TrajectoryCommand{Name: name, Count: counts[name]})
	}
	sort.SliceStable(commands, func(first, second int) bool { return commands[first].Count > commands[second].Count })
	if len(commands) > 12 {
		commands = commands[:12]
	}
	return commands
}

func trajectoryCommandSegments(text string) []string {
	replacer := strings.NewReplacer("&&", "\n", "||", "\n", "|", "\n", ";", "\n")
	names := []string{}
	for _, segment := range strings.Split(replacer.Replace(text), "\n") {
		fields := strings.Fields(segment)
		for len(fields) > 0 && (strings.Contains(fields[0], "=") || fields[0] == "sudo" || fields[0] == "env" || fields[0] == "time" || fields[0] == "command") {
			fields = fields[1:]
		}
		if len(fields) == 0 {
			continue
		}
		name := fields[0]
		if slash := strings.LastIndex(name, "/"); slash >= 0 && slash+1 < len(name) {
			name = name[slash+1:]
		}
		name = strings.TrimSuffix(name, ":")
		if name == "" || strings.HasPrefix(name, "-") {
			continue
		}
		names = append(names, name)
	}
	return names
}

func trajectoryFiles(store *TaskStore, taskId string) TrajectoryFiles {
	rows := kernelRows(store.Db, `SELECT tool,COUNT(*) AS count FROM tool_calls WHERE task_id=? GROUP BY tool`, taskId)
	files := TrajectoryFiles{}
	for _, row := range rows {
		count := int(kernelInt(row["count"]))
		switch strings.ToLower(kernelString(row["tool"])) {
		case "read", "read_file", "view", "cat", "read_image":
			files.Read += count
		case "write", "edit", "apply_patch", "apply_rsi_change", "write_file":
			files.Write += count
		case "grep", "glob", "list", "find", "search", "ls":
			files.Search += count
		case "image", "screenshot", "view_image":
			files.Image += count
		}
	}
	return files
}

func trajectoryToolStats(tools []TrajectoryTool) []TrajectoryToolStat {
	stats := []TrajectoryToolStat{}
	index := map[string]int{}
	for _, tool := range tools {
		position, ok := index[tool.Name]
		if !ok {
			index[tool.Name] = len(stats)
			stats = append(stats, TrajectoryToolStat{Name: tool.Name})
			position = len(stats) - 1
		}
		stats[position].Count++
		stats[position].Ms += tool.Ms
		if tool.IsError {
			stats[position].Errors++
		}
	}
	return stats
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
