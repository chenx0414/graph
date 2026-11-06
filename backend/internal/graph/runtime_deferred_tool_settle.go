package graph

import (
	"fmt"
	"strings"
)

// The one place a deferred tool call reaches its terminal state.
//
// Five things end a call - the tool returning, the tool raising, the user
// cancelling, the deadline passing, and the process that ran it going away -
// and they are four readings of one exit plus one restart. Every one of them
// leaves through this function, so a call cannot end in one way that forgets
// what the others promise: the terminal row, the released gate, the tool row
// of the transcript and the wake that tells the master all land together, or
// none of them do.
//
// The five steps, in order:
//
//  1. a call that is already terminal is returned as it is - the settle is
//     idempotent, so a retried settle cannot write a second observation;
//  2. the terminal state and the finish time are written;
//  3. the conversation's tool row is closed in place, under the same toolCallId
//     and the same activity key, so the console shows one call and not two;
//  4. the wake is written, deduplicated per call, so the master reads the
//     outcome exactly once;
//  5. the tool gate's ledger is settled (it only writes an event, so it does
//     not require the execution to still be running - which is the whole
//     point: the completion happens after the turn has ended).
//
// There is no zombie operation because steps 2-4 are one transaction: a
// failure rolls the whole thing back and the job (or the restart reconcile)
// still owns the row.
//
// Step 5 is outside that transaction because the gate settles in a transaction
// of its own, and the store keeps exactly one transaction open at a time: a
// settle inside another one waits for the lock the outer one holds, which is
// the documented way this store stops. The ledger entry is therefore written
// right after the terminal row, and a process that dies in between leaves a
// terminal row whose gate entry the next restart's reconcile cannot re-open
// (the reservation it releases is the zero-token tool reservation, which
// expires with the execution).
type deferredToolOutcome struct {
	State      DeferredToolCallState
	Reason     string
	Result     string
	Gate       SendGate
	GateCallId string
}

// finalizeDeferredToolCall is the deferred call's only terminal writer.
func finalizeDeferredToolCall(store *TaskStore, call DeferredToolCall, outcome deferredToolOutcome) DeferredToolCall {
	if outcome.State == "" {
		outcome.State = DeferredToolSettled
	}
	final := withStoreTx(store, func() any {
		current := DeferredToolCallById(store, call.Id)
		if current == nil {
			Raise("not_found", "The deferred tool call is not there")
		}
		if !DeferredToolCallActive(current.State) {
			return *current
		}
		finished := FinishDeferredToolCall(store, call.Id, outcome.State, outcome.Reason, outcome.Result, NowMillis())
		SettleConversationToolCall(store, finished)
		WakeForDeferredToolSettled(store, finished)
		return finished
	})
	if outcome.Gate.Settle != nil {
		outcome.Gate.Settle(outcome.GateCallId, &TokenUsage{})
	}
	if record, ok := final.(DeferredToolCall); ok {
		return record
	}
	if pointer, ok := final.(*DeferredToolCall); ok && pointer != nil {
		return *pointer
	}
	result := DeferredToolCallById(store, call.Id)
	if result == nil {
		return call
	}
	return *result
}

// DeferredToolCallFailureText is the one line a failed, cancelled, expired or
// interrupted call reports, in the words the user reads.
func DeferredToolCallFailureText(state DeferredToolCallState, reason string) string {
	detail := strings.TrimSpace(reason)
	if detail == "" {
		detail = "no reason was recorded"
	}
	switch state {
	case DeferredToolCancelled:
		return "已取消：" + truncateRunes(detail, 400)
	case DeferredToolTimedOut:
		return "已超时：" + truncateRunes(detail, 400)
	case DeferredToolInterrupted:
		return "已中断（守护进程重启，结果未知）：" + truncateRunes(detail, 400)
	default:
		return "失败：" + truncateRunes(detail, 400)
	}
}

// conversationToolRowData reads one message row's payload.
func conversationToolRowData(row map[string]any) map[string]any {
	if raw := kernelString(row["data"]); raw != "" {
		if parsed := asMap(parseJSON(raw)); parsed != nil {
			return parsed
		}
	}
	return map[string]any{}
}

// deferredToolObservationText is the tool row's text once the call is over.
//
// The console reads one row per call, so the row has to carry the outcome:
// the call it was, and what it produced or why it did not.
func deferredToolObservationText(call DeferredToolCall) string {
	name := call.ToolName
	summary := strings.TrimSpace(call.Summary)
	head := name
	if summary != "" {
		head = name + ": " + summary
	}
	if DeferredToolCallActive(call.State) {
		return head
	}
	if call.State == DeferredToolSettled {
		result := strings.TrimSpace(call.Result)
		if result == "" {
			return head + " → (no output)"
		}
		return head + " → " + truncateRunes(result, 2_000)
	}
	return head + " → " + DeferredToolCallFailureText(call.State, call.Reason)
}

// deferredToolDeadlineReached reports whether the call ended at or after its
// deadline, whatever stopped the command.
//
// The deadline is the daemon's own clock, and the command runner stops the
// process at the same instant the body asked for. Which of the two kills it
// first is a scheduling detail, so the outcome is read from the deadline
// itself instead of from a timer callback that may not have run yet: a call
// that came back at or after its deadline timed out, and one that came back
// before it did not.
func deferredToolDeadlineReached(call DeferredToolCall, budgetMs int) bool {
	if budgetMs <= 0 {
		return false
	}
	deadline := call.StartedAt + int64(budgetMs)
	if call.DeadlineAt != nil {
		deadline = *call.DeadlineAt
	}
	return NowMillis() >= deadline
}

// DeferredToolCallReason is the reason a caller reports for one call.
func deferredToolCallReason(call DeferredToolCall) string {
	if call.State == DeferredToolSettled {
		return ""
	}
	if strings.TrimSpace(call.Reason) == "" {
		return fmt.Sprintf("the %s call ended as %s", call.ToolName, call.State)
	}
	return call.Reason
}

// SettleConversationToolCall writes one deferred call's own state onto the
// transcript row it started as.
//
// It updates that row in place - same message id, same toolCallId, same
// activity key - so the outcome is one observation of one call rather than a
// second row next to it. A call that is still running keeps its row running:
// the settlement that closes it calls this again once the work is over.
//
// A session without a conversation has no row to update, and that is not a
// failure: the deferred row still carries the outcome and the wake still
// reaches the master.
func SettleConversationToolCall(store *TaskStore, call DeferredToolCall) {
	if strings.TrimSpace(call.ConversationId) == "" {
		return
	}
	if strings.HasPrefix(call.ToolCallId, deferredToolCallPlaceholderPrefix) {
		// The kernel never reported the call's own id, so there is no row it
		// could have written. The bind, when it comes, writes the row itself.
		return
	}
	row := kernelRow(store.Db, `SELECT id,data,operation_id,turn FROM messages
    WHERE conversation_id=? AND role='tool' AND (json_extract(data,'$.toolCallId')=? OR json_extract(data,'$.toolCallId')=?)
    ORDER BY seq LIMIT 1`, call.ConversationId, call.ToolCallId, deferredToolCallPlaceholder(call.Id))
	if row == nil {
		return
	}
	data := deferredToolRowData(conversationToolRowData(row), call)
	messageState := MessageStateRunning
	if !DeferredToolCallActive(call.State) {
		messageState = MessageStateDone
		if call.State != DeferredToolSettled {
			messageState = MessageStateFailed
		}
	}
	var dataValue any
	if len(data) > 0 {
		dataValue = CanonicalJSON(data)
	}
	messageId := kernelString(row["id"])
	operationId := kernelString(row["operation_id"])
	var operation *string
	if operationId != "" {
		operation = &operationId
	}
	store.SetMessageContent(call.ConversationId, messageId, deferredToolObservationText(call), dataValue,
		string(messageState), operation, int(kernelInt(row["turn"])), NowMillis())
	PublishMessageUpdate(store, messageId)
}

// deferredToolRowData is the payload the tool row carries.
//
// It keeps whatever the row already said (the tool name, the activity key, the
// ordinal, the attachments) and says what the call knows now: its state, its
// result, and - when it did not settle - one readable reason. The row is
// written from two places, the call's own settlement and the turn that
// dispatched it, and both read it from here so the two cannot disagree.
func deferredToolRowData(base map[string]any, call DeferredToolCall) map[string]any {
	data := map[string]any{}
	for name, value := range base {
		data[name] = value
	}
	data["toolCallId"] = call.ToolCallId
	if value, ok := data["tool"]; !ok || value == nil {
		data["tool"] = call.ToolName
	}
	// `state` is the name the console reads (laneB's contract): the deferred
	// state is what decides running/done and which stopped label to show, and
	// the message's own state cannot express "cancelled" versus "failed".
	data["state"] = string(call.State)
	if call.State == DeferredToolSettled {
		delete(data, "message")
		delete(data, "error")
		if result := strings.TrimSpace(call.Result); result != "" {
			data["result"] = truncateRunes(result, 2_000)
		}
		return data
	}
	if DeferredToolCallActive(call.State) {
		delete(data, "message")
		delete(data, "error")
		return data
	}
	data["error"] = true
	data["message"] = DeferredToolCallFailureText(call.State, call.Reason)
	return data
}
