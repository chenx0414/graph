package graph

import "strings"

// How the outcome of a deferred tool call reaches the conversation.
//
// The call outlived the turn that dispatched it, so there is no tool result
// left to answer: the round the model could have answered with one is over.
// The outcome therefore arrives the way every other fact that happens while no
// turn is running arrives - as a wake. The wake ledger is deduplicated per
// call, so one call produces one wake however often the settle is retried, and
// the master reads it in the brief of its next turn.
//
// It is deliberately not an orphan tool result: the transcript is answered
// per round by the kernel, and a result that belongs to no call of the current
// round is dropped there (and the call it belongs to is told "No result
// provided"). The one observation of the call is its own tool row, which the
// settle closes in place.
const (
	// WakeKindToolSettled is a deferred tool call that reached a terminal state.
	WakeKindToolSettled WakeKind = "tool_settled"
	// deferredToolWakeTruncate is how much of the outcome one wake carries. The
	// row is the record; the wake is the pointer to it.
	deferredToolWakeTruncate = 1_000
)

// WakeForDeferredToolSettled writes the one wake of a finished call.
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

// deferredToolWakeKey is the dedupe key of one call's wake.
//
// The row id names the call from the moment it was admitted, which is earlier
// than the model's own call id: using it keeps the key stable, so a settle
// that runs twice - once from the job and once from a restarted process's
// reconcile race - produces one wake and not two.
func deferredToolWakeKey(call DeferredToolCall) string {
	return "deferred:" + call.Id
}

// renderDeferredToolWake is the line the master reads in its next brief.
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
