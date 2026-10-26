package graph

import (
	"strings"

	"encoding/json"
)

// failureDetail is the one line worth showing from a failure blob: its longest early line
// carries the message while stack frames stay short. Single line, bounded.
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

// conversationFailureSuffix renders the optional reason of a failed turn.
func conversationFailureSuffix(detail string) string {
	if detail == "" {
		return ""
	}
	return " 原因：" + detail
}

// conversationProjectLine describes the project a conversation is bound to.
func conversationProjectLine(store *TaskStore, projectId *string) string {
	if projectId == nil || *projectId == "" {
		return "Project: not bound (ask the user to choose one from the configured projects)"
	}
	row := kernelRow(store.Db, "SELECT root FROM projects WHERE id=?", *projectId)
	if row == nil {
		return "Project: " + *projectId
	}
	return "Project: " + *projectId + " (root " + kernelString(row["root"]) + ")"
}

// conversationQuestionSummary is the one short line that answers "what is this problem".
func conversationQuestionSummary(kind string, data any) string {
	body, _ := data.(map[string]any)
	for _, key := range []string{"prompt", "reason", "message", "grant", "requested"} {
		if value, ok := body[key].(string); ok && strings.TrimSpace(value) != "" {
			return utf16Slice(strings.TrimSpace(value), 500)
		}
	}
	return "执行问题：" + kind
}

// conversationNodeSummary lists the nodes of one task and their status.
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

// conversationNodeSpec reads the spec of one node.
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

// conversationMessageRow reads one message row.
func conversationMessageRow(store *TaskStore, id string) (MessageRow, bool) {
	row := kernelRow(store.Db, "SELECT * FROM messages WHERE id=?", id)
	if row == nil {
		return MessageRow{}, false
	}
	return conversationMessageFromRow(row), true
}

// conversationMessageRows maps message rows.
func conversationMessageRows(rows []map[string]any) []MessageRow {
	messages := make([]MessageRow, 0, len(rows))
	for _, row := range rows {
		messages = append(messages, conversationMessageFromRow(row))
	}
	return messages
}

// conversationMessageFromRow maps one messages table row.
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

// conversationReverseRows reverses a page read backwards.
func conversationReverseRows(rows []map[string]any) []map[string]any {
	reversed := make([]map[string]any, 0, len(rows))
	for index := len(rows) - 1; index >= 0; index-- {
		reversed = append(reversed, rows[index])
	}
	return reversed
}

// conversationNullableString reads a nullable text column.
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

// conversationNullableInt reads a nullable integer column.
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

// conversationParseJson reads one stored JSON payload.
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

// conversationOrdinalData renders the payload a delivered message carries when the turn it
// joined has an ordinal.
//
// BUG(port): the TypeScript helper this mirrors (messageData) read the raw `data` column,
// which stores a JSON string, and then asked whether that value was an object. A string never
// is, so the helper always answered null and the delivered row kept only its ordinal: the
// earlier payload of the message was never merged back in. The TypeScript behaves the same
// way, so the port reproduces that instead of the intent behind it.
func conversationOrdinalData(message MessageRow, ordinal int) string {
	return `{"ordinal":` + itoa(ordinal) + `}`
}
