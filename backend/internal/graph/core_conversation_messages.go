package graph

import (
	"encoding/json"
	"strings"
)

// ConversationActivityRecords decides the ordered, deduplicated activity records of one
// completed master turn. The final reply is written separately, so a narration whose text
// is the reply itself is dropped instead of appearing twice. Older operations carry only
// tool activity, without a `type`. Pure, so the rule is testable without a store.
func ConversationActivityRecords(activity any, reply string) []ConversationActivityRecord {
	records := []ConversationActivityRecord{}
	for _, item := range conversationActivityItems(activity) {
		entry, ok := conversationActivityEntry(item)
		if !ok {
			continue
		}
		// The ordinal is the shared order of the turn's text parts and tool calls; the
		// transcript needs it to keep a steering message where it interrupted.
		ordinal := conversationActivityOrdinal(entry["ordinal"])
		if conversationActivityString(entry["type"]) == string(ConversationActivityNarration) {
			text := strings.TrimSpace(conversationActivityString(entry["text"]))
			if text == "" || text == reply {
				continue
			}
			record := ConversationActivityRecord{Kind: ConversationActivityNarration, Text: text}
			if ordinal != nil {
				record.Ordinal = ordinal
			}
			records = append(records, record)
			continue
		}
		summary := conversationActivityString(entry["summary"])
		if strings.TrimSpace(summary) == "" {
			continue
		}
		data := map[string]any{}
		text := summary
		if name, ok := entry["name"].(string); ok {
			data["tool"] = name
			text = name + ": " + summary
		} else {
			data["tool"] = "tool"
		}
		if toolCallId, ok := entry["toolCallId"].(string); ok {
			data["toolCallId"] = toolCallId
		}
		if conversationActivityString(entry["state"]) == "error" {
			data["error"] = true
		}
		record := ConversationActivityRecord{Kind: ConversationActivityTool, Text: text, Data: data}
		if ordinal != nil {
			record.Ordinal = ordinal
		}
		records = append(records, record)
	}
	return records
}

// PersistConversationActivity checkpoints completed narration and tool calls before a
// reload can stop the worker. Ordinals identify records across the checkpoint and final
// settlement.
func PersistConversationActivity(store *TaskStore, conversationId, operationId string, turn int,
	records []ConversationActivityRecord, activeToolIds map[string]bool) {
	type activityRow struct {
		id    string
		data  string
		text  string
		state string
	}
	existing := kernelRows(store.Db, "SELECT id,data,text,state FROM messages WHERE operation_id=? AND role IN ('activity','tool')", operationId)
	byKey := map[string]activityRow{}
	for _, row := range existing {
		data := kernelString(row["data"])
		// BUG(port): a row without an activity key stringifies to "undefined", so every
		// such row shares one map slot. The TypeScript did the same.
		key := "undefined"
		if data != "" {
			var parsed map[string]any
			if err := json.Unmarshal([]byte(data), &parsed); err == nil {
				if value, ok := parsed["activityKey"]; ok {
					key = conversationActivityStringify(value)
				}
			}
		}
		byKey[key] = activityRow{
			id:    kernelString(row["id"]),
			data:  data,
			text:  kernelString(row["text"]),
			state: kernelString(row["state"]),
		}
	}
	for index, record := range records {
		key := conversationActivityKey(record, index)
		previous, hasPrevious := byKey[key]
		previousData := map[string]any{}
		if hasPrevious && previous.data != "" {
			var parsed map[string]any
			if err := json.Unmarshal([]byte(previous.data), &parsed); err == nil && parsed != nil {
				previousData = parsed
			}
		}
		data := map[string]any{}
		if record.Kind == ConversationActivityTool {
			for name, value := range record.Data {
				data[name] = value
			}
		}
		data["activityKey"] = key
		if record.Ordinal != nil {
			data["ordinal"] = *record.Ordinal
		}
		if record.Kind == ConversationActivityTool {
			if attachments, ok := previousData["attachments"].([]any); ok {
				data["attachments"] = attachments
			}
		}
		state := string(MessageStateDone)
		if record.Kind == ConversationActivityTool {
			if toolCallId, ok := record.Data["toolCallId"].(string); ok && activeToolIds[toolCallId] {
				state = string(MessageStatePending)
			}
		}
		if hasPrevious && previous.text == record.Text && previous.state == state &&
			previous.data == CanonicalJSON(data) {
			continue
		}
		var messageId *string
		if hasPrevious {
			id := previous.id
			messageId = &id
		}
		role := MessageRoleTool
		kind := "tool"
		if record.Kind == ConversationActivityNarration {
			role = MessageRoleActivity
			kind = "activity"
		}
		AppendMessage(store, MessageInput{
			ConversationID: conversationId,
			OperationID:    &operationId,
			Turn:           turn,
			Role:           role,
			Kind:           kind,
			Text:           record.Text,
			Data:           data,
			State:          MessageState(state),
			MessageID:      messageId,
		})
	}
}
