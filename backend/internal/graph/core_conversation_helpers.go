package graph

import (
	"strings"

	"encoding/json"
)

func failureDetail(reason string) string {
	lines := []string{}
	for _, part := range strings.Split(reason, "\n") {
		line := strings.Join(strings.Fields(part), " ")
		if line == "" {
			continue
		}
		lines = append(lines, line)
		if len(lines) == 8 {
			break
		}
	}
	best := ""
	for _, line := range lines {
		if utf16Len(line) > utf16Len(best) {
			best = line
		}
	}
	return utf16Slice(best, 240)
}

func conversationFailureSuffix(detail string) string {
	if detail == "" {
		return ""
	}
	return " 原因：" + detail
}

func conversationProjectLine(store *TaskStore, conversation ConversationRow) string {
	if conversation.ProjectId == nil || *conversation.ProjectId == "" {
		switch conversation.Role {
		case ConversationGlobal:
			return "Project: not bound - choose it yourself from the goal: this checkout's own repository is your workspace (its harness, console, backend and prompts are yours to change and verify with apply_rsi_change), and every other project goes through delegate_work. Ask the user only when the goal points at no repository at all."
		case ConversationProject:
			return "Project: not bound - this project thread cannot create work for another project"
		}
		return "Project: not bound"
	}
	row := kernelRow(store.Db, "SELECT root FROM projects WHERE id=?", *conversation.ProjectId)
	if row == nil {
		return "Project: " + *conversation.ProjectId
	}
	return "Project: " + *conversation.ProjectId + " (root " + kernelString(row["root"]) + ")"
}

func conversationQuestionSummary(kind string, data any) string {
	body, _ := data.(map[string]any)
	for _, key := range []string{"prompt", "reason", "message", "grant", "requested"} {
		if value, ok := body[key].(string); ok && strings.TrimSpace(value) != "" {
			return utf16Slice(strings.TrimSpace(value), 500)
		}
	}
	return "执行问题：" + kind
}

func conversationNodeSummary(store *TaskStore, kernel *KernelStore, taskId string) string {
	if kernel.LatestRevision(taskId) != nil {
		nodes := kernel.ListNodes(taskId)
		parts := []string{}
		for _, node := range nodes {
			parts = append(parts, node.NodeId+":"+node.Status)
		}
		return strings.Join(parts, ", ")
	}
	rows := kernelRows(store.Db, "SELECT id,spec,status FROM nodes WHERE task_id=? ORDER BY rowid", taskId)
	parts := []string{}
	for _, row := range rows {
		parts = append(parts, kernelString(row["id"])+":"+kernelString(row["status"]))
	}
	return strings.Join(parts, ", ")
}

func conversationNodeSpec(store *TaskStore, taskId, nodeId string) NodeSpec {
	row := kernelRow(store.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	if row == nil {
		Raise("not_found", "No node for this operation")
	}
	var spec NodeSpec
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
		panic(err)
	}
	return spec
}

func conversationMessageRow(store *TaskStore, id string) (MessageRow, bool) {
	row := kernelRow(store.Db, "SELECT * FROM messages WHERE id=?", id)
	if row == nil {
		return MessageRow{}, false
	}
	return conversationMessageFromRow(row), true
}

func conversationMessageRows(rows []map[string]any) []MessageRow {
	messages := make([]MessageRow, 0, len(rows))
	for _, row := range rows {
		messages = append(messages, conversationMessageFromRow(row))
	}
	return messages
}

func conversationMessageFromRow(row map[string]any) MessageRow {
	return MessageRow{
		Seq:            kernelInt(row["seq"]),
		Id:             kernelString(row["id"]),
		ConversationId: kernelString(row["conversation_id"]),
		Role:           kernelString(row["role"]),
		Kind:           kernelString(row["kind"]),
		Text:           kernelString(row["text"]),
		Data:           conversationNullableString(row["data"]),
		State:          kernelString(row["state"]),
		OperationId:    conversationNullableString(row["operation_id"]),
		Turn:           kernelInt(row["turn"]),
		CreatedAt:      kernelInt(row["created_at"]),
		UpdatedAt:      kernelInt(row["updated_at"]),
	}
}

func conversationReverseRows(rows []map[string]any) []map[string]any {
	reversed := make([]map[string]any, 0, len(rows))
	for index := len(rows) - 1; index >= 0; index-- {
		reversed = append(reversed, rows[index])
	}
	return reversed
}

func conversationNullableString(value any) *string {
	switch typed := value.(type) {
	case string:
		return &typed
	case []byte:
		text := string(typed)
		return &text
	default:
		return nil
	}
}

func conversationNullableInt(value any) *int64 {
	switch typed := value.(type) {
	case int64:
		return &typed
	case int:
		number := int64(typed)
		return &number
	case float64:
		number := int64(typed)
		return &number
	default:
		return nil
	}
}

func conversationParseJson(text string) any {
	if text == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		panic(err)
	}
	return value
}

func conversationOrdinalData(message MessageRow, ordinal int) string {
	body := map[string]any{}
	if message.Data != nil {
		existing := map[string]any{}
		if err := json.Unmarshal([]byte(*message.Data), &existing); err == nil {
			body = existing
		}
	}
	body["ordinal"] = ordinal
	return CanonicalJSON(body)
}
