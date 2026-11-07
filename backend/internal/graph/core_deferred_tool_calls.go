package graph

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

type DeferredToolCallState string

const (
	DeferredToolCallRetentionMs    int64 = 60 * 60 * 1000
	DeferredToolCallPollIntervalMs int64 = 2_000
)

const DeferredToolCallsPerConversation = 4

func DeferredToolCallSlot(store *TaskStore, conversationId string) error {
	active := 0
	for _, call := range DeferredToolCallsOfConversation(store, conversationId) {
		if DeferredToolCallActive(call.State) {
			active++
		}
	}
	if active < DeferredToolCallsPerConversation {
		return nil
	}
	return fmt.Errorf("this conversation already runs %d background calls (limit %d); wait for one to settle or cancel it before starting another",
		active, DeferredToolCallsPerConversation)
}

func deferredToolCallRetentionLeft(call DeferredToolCall) int64 {
	left := call.StartedAt + DeferredToolCallRetentionMs - time.Now().UnixMilli()
	if left < 0 {
		return 0
	}
	return left
}

const (
	DeferredToolAccepted DeferredToolCallState = "accepted"
	DeferredToolRunning DeferredToolCallState = "running"
	DeferredToolSettled DeferredToolCallState = "settled"
	DeferredToolFailed DeferredToolCallState = "failed"
	DeferredToolCancelled DeferredToolCallState = "cancelled"
	DeferredToolTimedOut DeferredToolCallState = "timed_out"
	DeferredToolInterrupted DeferredToolCallState = "interrupted"
)

func DeferredToolCallActive(state DeferredToolCallState) bool {
	return state == DeferredToolAccepted || state == DeferredToolRunning
}

type DeferredToolCall struct {
	Id             string                `json:"id"`
	TaskId         string                `json:"taskId"`
	ConversationId string                `json:"conversationId"`
	NodeId         string                `json:"nodeId"`
	ExecutionId    string                `json:"executionId"`
	OperationId    string                `json:"operationId"`
	ToolCallId     string                `json:"toolCallId"`
	ToolName       string                `json:"toolName"`
	RequestId      string                `json:"requestId"`
	RequestDigest  string                `json:"requestDigest"`
	State          DeferredToolCallState `json:"state"`
	Args           string                `json:"args"`
	Summary        string                `json:"summary"`
	Result         string                `json:"result"`
	Reason         string                `json:"reason"`
	StartedAt      int64                 `json:"startedAt"`
	DeadlineAt     *int64                `json:"deadlineAt"`
	FinishedAt     *int64                `json:"finishedAt"`
}

func deferredToolCallPlaceholder(id string) string {
	return deferredToolCallPlaceholderPrefix + id
}

const deferredToolCallPlaceholderPrefix = "deferred:"

type DeferredToolCallInput struct {
	TaskId         string
	ConversationId string
	NodeId         string
	ExecutionId    string
	OperationId    string
	ToolName       string
	RequestId      string
	RequestDigest  string
	Args           string
	Summary        string
	StartedAt      int64
	DeadlineAt     *int64
}

func RecordDeferredToolCall(store *TaskStore, input DeferredToolCallInput) (DeferredToolCall, bool) {
	conversationId := nullableText(input.ConversationId)
	id := newUUID()
	inserted := kernelExec(store.Db, `INSERT OR IGNORE INTO deferred_tool_calls(
      id,task_id,conversation_id,node_id,execution_id,operation_id,tool_call_id,tool_name,
      request_id,request_digest,state,args,summary,started_at,deadline_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',?,?,?,?)`,
		id, input.TaskId, conversationId, input.NodeId, input.ExecutionId, input.OperationId,
		deferredToolCallPlaceholder(id), input.ToolName, input.RequestId, input.RequestDigest,
		nullableText(input.Args), nullableText(input.Summary), input.StartedAt, nullableInt(input.DeadlineAt))
	if sqliteRowCount(inserted) > 0 {
		row := DeferredToolCallById(store, id)
		return *row, true
	}
	existing := DeferredToolCallByRequestId(store, input.ConversationId, input.RequestId)
	if existing == nil {
		Raise("internal", "The deferred tool call could not be recorded")
	}
	return *existing, false
}

func DeferredToolCallById(store *TaskStore, id string) *DeferredToolCall {
	row := kernelRow(store.Db, "SELECT * FROM deferred_tool_calls WHERE id=?", id)
	return deferredToolCallRow(row)
}

func DeferredToolCallByRequestId(store *TaskStore, conversationId, requestId string) *DeferredToolCall {
	row := kernelRow(store.Db, "SELECT * FROM deferred_tool_calls WHERE conversation_id IS ? AND request_id=?",
		nullableText(conversationId), requestId)
	return deferredToolCallRow(row)
}

func DeferredToolCallByModelCall(store *TaskStore, conversationId, toolCallId string) *DeferredToolCall {
	row := kernelRow(store.Db, "SELECT * FROM deferred_tool_calls WHERE conversation_id IS ? AND tool_call_id=?",
		nullableText(conversationId), toolCallId)
	return deferredToolCallRow(row)
}

func DeferredToolCallByTaskCall(store *TaskStore, taskId, nodeId, toolCallId string) *DeferredToolCall {
	row := kernelRow(store.Db, "SELECT * FROM deferred_tool_calls WHERE task_id=? AND node_id=? AND tool_call_id=?",
		taskId, nodeId, toolCallId)
	return deferredToolCallRow(row)
}

func DeferredToolCallsOfConversation(store *TaskStore, conversationId string) []DeferredToolCall {
	rows := kernelRows(store.Db, "SELECT * FROM deferred_tool_calls WHERE conversation_id IS ? ORDER BY started_at, rowid",
		nullableText(conversationId))
	out := make([]DeferredToolCall, 0, len(rows))
	for _, row := range rows {
		if call := deferredToolCallRow(row); call != nil {
			out = append(out, *call)
		}
	}
	return out
}

func LiveDeferredToolCallIds(store *TaskStore, conversationId string) map[string]bool {
	live := map[string]bool{}
	for _, call := range DeferredToolCallsOfConversation(store, conversationId) {
		if DeferredToolCallActive(call.State) && !strings.HasPrefix(call.ToolCallId, deferredToolCallPlaceholderPrefix) {
			live[call.ToolCallId] = true
		}
	}
	return live
}

func MarkDeferredToolCallRunning(store *TaskStore, id string) {
	kernelExec(store.Db, "UPDATE deferred_tool_calls SET state='running' WHERE id=? AND state='accepted'", id)
}

func BindDeferredToolCallModelCall(store *TaskStore, id, toolCallId string) *DeferredToolCall {
	if id != "" && toolCallId != "" {
		if bound := DeferredToolCallByModelCall(store, conversationIdOfDeferredToolCall(store, id), toolCallId); bound != nil && bound.Id != id {
			return bound
		}
		kernelExec(store.Db, `UPDATE deferred_tool_calls SET tool_call_id=? WHERE id=? AND tool_call_id=?`,
			toolCallId, id, deferredToolCallPlaceholder(id))
	}
	return DeferredToolCallById(store, id)
}

func conversationIdOfDeferredToolCall(store *TaskStore, id string) string {
	if call := DeferredToolCallById(store, id); call != nil {
		return call.ConversationId
	}
	return ""
}

func FinishDeferredToolCall(store *TaskStore, id string, state DeferredToolCallState, reason, result string, finishedAt int64) DeferredToolCall {
	kernelExec(store.Db, `UPDATE deferred_tool_calls
      SET state=?, reason=?, result=?, finished_at=COALESCE(finished_at,?)
      WHERE id=? AND state IN ('accepted','running')`,
		string(state), nullableText(reason), nullableText(result), finishedAt, id)
	row := DeferredToolCallById(store, id)
	if row == nil {
		Raise("not_found", "The deferred tool call is not there")
	}
	return *row
}

func DeferredToolCallsWithoutJob(store *TaskStore, owned func(id string) bool) []DeferredToolCall {
	rows := kernelRows(store.Db, "SELECT * FROM deferred_tool_calls WHERE state IN ('accepted','running') ORDER BY started_at")
	out := []DeferredToolCall{}
	for _, row := range rows {
		call := deferredToolCallRow(row)
		if call == nil || owned(call.Id) {
			continue
		}
		out = append(out, *call)
	}
	return out
}

func deferredToolCallRow(row map[string]any) *DeferredToolCall {
	if row == nil {
		return nil
	}
	call := &DeferredToolCall{
		Id:             kernelString(row["id"]),
		TaskId:         kernelString(row["task_id"]),
		ConversationId: kernelString(row["conversation_id"]),
		NodeId:         kernelString(row["node_id"]),
		ExecutionId:    kernelString(row["execution_id"]),
		OperationId:    kernelString(row["operation_id"]),
		ToolCallId:     kernelString(row["tool_call_id"]),
		ToolName:       kernelString(row["tool_name"]),
		RequestId:      kernelString(row["request_id"]),
		RequestDigest:  kernelString(row["request_digest"]),
		State:          DeferredToolCallState(kernelString(row["state"])),
		Args:           kernelString(row["args"]),
		Summary:        kernelString(row["summary"]),
		Result:         kernelString(row["result"]),
		Reason:         kernelString(row["reason"]),
		StartedAt:      kernelInt(row["started_at"]),
	}
	if row["deadline_at"] != nil {
		deadline := kernelInt(row["deadline_at"])
		call.DeadlineAt = &deadline
	}
	if row["finished_at"] != nil {
		finished := kernelInt(row["finished_at"])
		call.FinishedAt = &finished
	}
	return call
}

func nullableText(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableInt(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func sqliteRowCount(result sql.Result) int64 {
	rows, err := result.RowsAffected()
	if err != nil {
		return 0
	}
	return rows
}
