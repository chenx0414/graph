package graph

import (
	"encoding/json"
	"sort"
	"strings"
)

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
	rows := kernelRows(store.Db, `SELECT text FROM messages WHERE conversation_id=? AND role='tool' AND text LIKE 'bash:%' ORDER BY seq`, conversationId)
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

func estimateTrajectoryTokens(text string) int64 {
	ascii, wide := 0, 0
	for _, char := range text {
		if char < 128 {
			ascii++
		} else {
			wide++
		}
	}
	return int64(wide) + int64((ascii+3)/4)
}

func trajectoryComposition(store *TaskStore, conversationId, taskId string) TrajectoryComposition {
	composition := TrajectoryComposition{}
	operation := kernelRow(store.Db, `SELECT COALESCE(system_prompt,'') AS system_prompt,COALESCE(tool_declarations,'') AS tool_declarations
		FROM operations WHERE task_id=? ORDER BY rowid DESC LIMIT 1`, taskId)
	if operation != nil {
		composition.SystemPrompt = estimateTrajectoryTokens(kernelString(operation["system_prompt"]))
		composition.ToolDefinitions = estimateTrajectoryTokens(kernelString(operation["tool_declarations"]))
	}
	rows := kernelRows(store.Db, `SELECT role,kind,text FROM messages WHERE conversation_id=?`, conversationId)
	for _, row := range rows {
		role, kind := kernelString(row["role"]), kernelString(row["kind"])
		text := kernelString(row["text"])
		switch {
		case role == "user" && kind == "chat":
			composition.UserMessages += estimateTrajectoryTokens(text)
		case role == "assistant" && kind == "chat":
			composition.AssistantReply += estimateTrajectoryTokens(text)
		case role == "tool" && kind == "tool":
			composition.ToolCalls += estimateTrajectoryTokens(text)
		case role == "system" && kind != "rsi" && kind != "activity":
			composition.Injected += estimateTrajectoryTokens(text)
		}
	}
	return composition
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
