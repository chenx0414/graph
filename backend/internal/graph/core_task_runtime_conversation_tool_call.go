package graph

import (
	"strings"
)

// The two HTTP facts a person and the console need about deferred tool calls:
// what the calls are, and how to stop one.
//
// Both answers are read from the rows, never from memory: a daemon that
// restarted still answers for the calls the previous process admitted, and the
// answer a request id got the first time is the answer it gets again.

// DeferredToolCallView is one deferred call, as the API returns it.
type DeferredToolCallView struct {
	ToolCallId  string `json:"toolCallId"`
	Name        string `json:"name"`
	Summary     string `json:"summary"`
	State       string `json:"state"`
	RequestId   string `json:"requestId"`
	OperationId string `json:"operationId"`
	StartedAt   int64  `json:"startedAt"`
	FinishedAt  *int64 `json:"finishedAt"`
	Reason      string `json:"reason,omitempty"`
	Result      string `json:"result,omitempty"`
}

// ToolCalls lists the deferred calls of one conversation, oldest first.
func (conversations *TaskRuntimeConversations) ToolCalls(conversationId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	calls := DeferredToolCallsOfConversation(runtime.store, conversationId)
	views := make([]DeferredToolCallView, 0, len(calls))
	for _, call := range calls {
		views = append(views, deferredToolCallView(call))
	}
	return map[string]any{"toolCalls": views}
}

// deferredToolCallView is one row as the protocol names it.
func deferredToolCallView(call DeferredToolCall) DeferredToolCallView {
	view := DeferredToolCallView{
		ToolCallId: call.ToolCallId, Name: call.ToolName, Summary: call.Summary,
		State: deferredToolProtocolState(call.State), RequestId: call.RequestId,
		OperationId: call.OperationId, StartedAt: call.StartedAt, FinishedAt: call.FinishedAt,
	}
	if !DeferredToolCallActive(call.State) {
		view.Reason = deferredToolCallReason(call)
	}
	if call.State == DeferredToolSettled {
		view.Result = truncateRunes(call.Result, 8_000)
	}
	return view
}

// CancelToolCall withdraws one deferred call.
//
// The answer is the call's own state after the withdrawal, so a caller that
// asks twice learns the same thing twice, and a caller that asks about a call
// that is already over learns what ended it instead of a second cancel.
func (conversations *TaskRuntimeConversations) CancelToolCall(conversationId, toolCallId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	if strings.TrimSpace(toolCallId) == "" {
		Raise("invalid_input", "A toolCallId is required")
	}
	payload := map[string]any{"type": "cancel_tool_call", "conversationId": conversationId, "toolCallId": toolCallId}
	if receipt, ok := deferredToolCommandReceipt(runtime.store, "conversation:"+conversationId, requestId, payload); ok {
		record, _ := jsonRecord(receipt)
		if record == nil {
			return map[string]any{}
		}
		return record
	}
	call := deferredToolCallFor(runtime.store, conversationId, toolCallId)
	if call == nil {
		result := map[string]any{"toolCallId": toolCallId, "state": "missing", "reason": "no such tool call", "cursor": nil}
		deferredToolRecordCommand(runtime.store, "conversation:"+conversationId, requestId, payload, result)
		return result
	}
	settled := cancelDeferredToolCall(runtime.store, *call)
	cursor := runtime.store.Event(conversation.AnchorTaskId, "tool_call.cancelled", map[string]any{
		"conversationId": conversationId, "toolCallId": settled.ToolCallId, "state": string(settled.State),
	})
	result := map[string]any{
		"toolCallId": settled.ToolCallId,
		"state":      deferredToolProtocolState(settled.State),
		"reason":     deferredToolCallReason(settled),
		"cursor":     cursor,
	}
	deferredToolRecordCommand(runtime.store, "conversation:"+conversationId, requestId, payload, result)
	return result
}

// deferredToolCallFor reads one call by the id the caller named, or by its row
// id when the call has not been bound yet.
func deferredToolCallFor(store *TaskStore, conversationId, toolCallId string) *DeferredToolCall {
	if call := DeferredToolCallByModelCall(store, conversationId, toolCallId); call != nil {
		return call
	}
	return DeferredToolCallById(store, strings.TrimPrefix(toolCallId, deferredToolCallPlaceholderPrefix))
}

// cancelDeferredToolCall stops one call and returns it in its terminal state.
//
// A call this process runs is stopped the way the daemon stops a command: the
// abort signal is set first, the job notices it, and the job's own settle
// writes the terminal state - so the process is really gone before the row
// says it is. A call whose job is not here (the previous process ran it) is
// recorded as cancelled directly, because there is nothing left to stop.
func cancelDeferredToolCall(store *TaskStore, call DeferredToolCall) DeferredToolCall {
	if !DeferredToolCallActive(call.State) {
		return call
	}
	job := deferredToolJobOf(call.Id)
	if job == nil {
		return finalizeDeferredToolCall(store, call, deferredToolOutcome{
			State: DeferredToolCancelled, Reason: "cancelled by the user before the job ran",
		})
	}
	job.markCancelled()
	job.signal.Abort()
	<-job.done
	settled := DeferredToolCallById(store, call.Id)
	if settled == nil {
		return call
	}
	return *settled
}

// deferredToolCommandReceipt is the receipt a request id already produced.
func deferredToolCommandReceipt(store *TaskStore, scope, requestId string, payload any) (any, bool) {
	if strings.TrimSpace(requestId) == "" || len(requestId) > 200 {
		Raise("invalid_input", "A bounded requestId is required")
	}
	row := kernelRow(store.Db, "SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?", scope, requestId)
	if row == nil {
		return nil, false
	}
	if kernelString(row["payload"]) != CanonicalJSON(payload) {
		Raise("idempotency_conflict", "requestId was already used with different content")
	}
	return parseJSON(kernelString(row["receipt"])), true
}

// deferredToolRecordCommand records the receipt of one withdraw, so a repeated
// request with the same id gets the same answer.
//
// It is written after the call settled and outside any transaction of its own,
// because the withdraw waits for the job to exit - and a job that could not
// take a transaction while this one holds the store would deadlock with it.
func deferredToolRecordCommand(store *TaskStore, scope, requestId string, payload, result any) {
	store.RecordCommand(scope, requestId, CanonicalJSON(payload), CanonicalJSON(result))
}
