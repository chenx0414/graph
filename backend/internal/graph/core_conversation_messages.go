package graph

import (
	"strings"

	"encoding/json"
)

func ConversationActivityRecords(activity any, reply string) []ConversationActivityRecord {
	records := []ConversationActivityRecord{}
	for _, item := range conversationActivityItems(activity) {
		entry, ok := conversationActivityEntry(item)
		if !ok {
			continue
		}
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
		if message := strings.TrimSpace(conversationActivityString(entry["message"])); message != "" {
			data["message"] = message
			text = text + " → " + truncateRunes(message, 400)
		}
		if result := strings.TrimSpace(conversationActivityString(entry["result"])); result != "" {
			data["result"] = result
			text = text + " → " + truncateRunes(result, 400)
		}
		if output := conversationActivityString(entry["output"]); strings.TrimSpace(output) != "" {
			data["output"] = truncateRunes(output, 8_000)
		}
		if args, ok := entry["args"]; ok && args != nil {
			if encoded, err := json.Marshal(args); err == nil && string(encoded) != "{}" && string(encoded) != "null" {
				data["args"] = truncateRunes(string(encoded), 2_000)
			}
		}
		record := ConversationActivityRecord{Kind: ConversationActivityTool, Text: text, Data: data}
		if ordinal != nil {
			record.Ordinal = ordinal
		}
		records = append(records, record)
	}
	return records
}

func PersistConversationActivity(store *TaskStore, conversationId, operationId string, turn int,
	records []ConversationActivityRecord, activeToolIds map[string]bool, runningToolIds map[string]bool) {
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
		deferred := conversationDeferredToolCall(store, conversationId, record)
		if deferred != nil {
			record = conversationDeferredToolRecord(record, *deferred)
		}
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
		if deferred != nil {
			switch {
			case DeferredToolCallActive(deferred.State):
				state = string(MessageStateRunning)
			case deferred.State != DeferredToolSettled:
				state = string(MessageStateFailed)
			}
		} else if record.Kind == ConversationActivityTool {
			toolCallId, _ := record.Data["toolCallId"].(string)
			if runningToolIds[toolCallId] {
				state = string(MessageStateRunning)
			} else if activeToolIds[toolCallId] {
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

func conversationDeferredToolCall(store *TaskStore, conversationId string, record ConversationActivityRecord) *DeferredToolCall {
	if record.Kind != ConversationActivityTool {
		return nil
	}
	toolCallId, _ := record.Data["toolCallId"].(string)
	if toolCallId == "" {
		return nil
	}
	return DeferredToolCallByModelCall(store, conversationId, toolCallId)
}

func conversationDeferredToolRecord(record ConversationActivityRecord, call DeferredToolCall) ConversationActivityRecord {
	record.Data = deferredToolRowData(record.Data, call)
	record.Text = deferredToolObservationText(call)
	return record
}
