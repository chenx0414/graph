package graph

import (
	"fmt"
	"strings"
)

type deferredToolOutcome struct {
	State      DeferredToolCallState
	Reason     string
	Result     string
	Gate       SendGate
	GateCallId string
}

func finalizeDeferredToolCall(store *TaskStore, call DeferredToolCall, outcome deferredToolOutcome) DeferredToolCall {
	if outcome.State == "" {
		outcome.State = DeferredToolSettled
	}
	pending := DeferredToolCall{}
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
		if WakeForDeferredToolSettled(store, finished) {
			queueDeferredToolResume(store, finished)
			pending = finished
		}
		return finished
	})
	if pending.Id != "" {
		if !deliverDeferredResultToRunningTurn(pending.ConversationId, "deferred:"+pending.Id) {
			RecoverMaster(store, queueDeferredToolAnchor(store, pending), "message")
		}
	}
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

func conversationToolRowData(row map[string]any) map[string]any {
	if raw := kernelString(row["data"]); raw != "" {
		if parsed := asMap(parseJSON(raw)); parsed != nil {
			return parsed
		}
	}
	return map[string]any{}
}

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

func deferredToolCallReason(call DeferredToolCall) string {
	if call.State == DeferredToolSettled {
		return ""
	}
	if strings.TrimSpace(call.Reason) == "" {
		return fmt.Sprintf("the %s call ended as %s", call.ToolName, call.State)
	}
	return call.Reason
}

func SettleConversationToolCall(store *TaskStore, call DeferredToolCall) {
	if strings.TrimSpace(call.ConversationId) == "" {
		return
	}
	if strings.HasPrefix(call.ToolCallId, deferredToolCallPlaceholderPrefix) {
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

func deferredToolRowData(base map[string]any, call DeferredToolCall) map[string]any {
	data := map[string]any{}
	for name, value := range base {
		data[name] = value
	}
	data["toolCallId"] = call.ToolCallId
	if value, ok := data["tool"]; !ok || value == nil {
		data["tool"] = call.ToolName
	}
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
