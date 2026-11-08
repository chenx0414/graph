package graph

import "strings"

const (
	WakeKindToolSettled WakeKind = "tool_settled"
	deferredToolWakeTruncate = 1_000
)

func WakeForDeferredToolSettled(store *TaskStore, call DeferredToolCall) bool {
	data := map[string]any{
		"toolCallId": call.ToolCallId, "toolName": call.ToolName,
		"deferredId": call.Id, "state": string(call.State),
		"ok":             call.State == DeferredToolSettled,
		"conversationId": call.ConversationId,
	}
	if reason := strings.TrimSpace(call.Reason); reason != "" {
		data["reason"] = truncateRunes(reason, deferredToolWakeTruncate)
	}
	if result := strings.TrimSpace(call.Result); result != "" {
		data["result"] = truncateRunes(result, deferredToolWakeTruncate)
	}
	return WakeMaster(store, WakeIntent{
		TaskID:    call.TaskId,
		Kind:      WakeKindToolSettled,
		DedupeKey: deferredToolWakeKey(call),
		Data:      data,
		HasData:   true,
	})
}

func deferredToolWakeKey(call DeferredToolCall) string {
	return "deferred:" + call.Id
}

func renderDeferredToolWake(data map[string]any, dedupeKey string) string {
	name := jsString(coalesce(data["toolName"], "tool"))
	callId := jsString(coalesce(data["toolCallId"], dedupeKey))
	state := jsString(coalesce(data["state"], "settled"))
	if data["ok"] == true {
		result := strings.TrimSpace(jsString(data["result"]))
		if result == "" {
			result = "(no output)"
		}
		return "- Background tool " + name + " (call " + callId + ") finished. Its result: " + result +
			" Report it to the user; do not call the tool again for the same work."
	}
	reason := strings.TrimSpace(jsString(data["reason"]))
	if reason == "" || reason == "undefined" {
		reason = "no reason was recorded"
	}
	return "- Background tool " + name + " (call " + callId + ") ended as " + state + ": " + reason +
		" Tell the user what happened; decide yourself whether a different attempt is worth it."
}
