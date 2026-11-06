package graph

import (
	"strings"

	"encoding/json"
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
		// A tool row carries the outcome it produced, not only the call it was:
		// the console has one row per call, so the result (or the reason there
		// is none) belongs to that row.
		if message := strings.TrimSpace(conversationActivityString(entry["message"])); message != "" {
			data["message"] = message
			text = text + " → " + truncateRunes(message, 400)
		}
		if result := strings.TrimSpace(conversationActivityString(entry["result"])); result != "" {
			data["result"] = result
			text = text + " → " + truncateRunes(result, 400)
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
		// A background tool call is read from its own row, not from the turn that
		// dispatched it: the turn ended long before the work did, and a record
		// rebuilt from the turn's activity would say the call is over (or lose
		// what it produced) every time the turn is written again.
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
			// The call's own row decides, so the transcript says what the call
			// is doing now instead of what the turn remembered about it.
			switch {
			case DeferredToolCallActive(deferred.State):
				state = string(MessageStateRunning)
			case deferred.State != DeferredToolSettled:
				state = string(MessageStateFailed)
			}
		} else if record.Kind == ConversationActivityTool {
			toolCallId, _ := record.Data["toolCallId"].(string)
			// A background call outlives the turn that dispatched it, so it is
			// neither done (the work has not finished) nor pending (no message
			// is waiting): it is running, and the console shows it that way
			// until its own settlement closes the row.
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

// conversationDeferredToolCall is the background call one activity record
// describes, when it describes one.
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

// conversationDeferredToolRecord is one tool record with the background call's
// own state written into it.
//
// The call keeps its place in the turn (same key, same ordinal, same summary);
// what changes is what it says: running while it runs, and its result or its
// reason once it is over.
func conversationDeferredToolRecord(record ConversationActivityRecord, call DeferredToolCall) ConversationActivityRecord {
	record.Data = deferredToolRowData(record.Data, call)
	record.Text = deferredToolObservationText(call)
	return record
}
