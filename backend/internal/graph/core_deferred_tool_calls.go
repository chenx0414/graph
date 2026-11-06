package graph

import (
	"database/sql"
	"strings"
)

// The deferred tool call: a tool call whose work outlives the turn that
// dispatched it.
//
// This file is the shape of one row and the only writer of the table. The
// lifecycle rules live next door (runtime_deferred_tool_*.go): the admission
// creates the row, the one settling function writes its terminal state, and
// the startup reconcile closes the rows no live job owns.
//
// Two identities matter and they are not the same:
//
//   - `id` names the row from the moment the call is admitted, before the
//     model's own tool call id exists (the daemon's tool wrapper never sees
//     it: the kernel hands the tool its arguments only).
//   - `tool_call_id` is the id the model, the transcript and the console know
//     the call by. It is bound a moment later, when the kernel reports the
//     call's start or its result, and every observation of the outcome is
//     written under that id so the call has exactly one row in the
//     conversation - the row it started as.
type DeferredToolCallState string

const (
	// DeferredToolAccepted is the call the daemon took responsibility for and
	// has not started yet.
	DeferredToolAccepted DeferredToolCallState = "accepted"
	// DeferredToolRunning is the call whose job is executing.
	DeferredToolRunning DeferredToolCallState = "running"
	// DeferredToolSettled is the call whose tool returned.
	DeferredToolSettled DeferredToolCallState = "settled"
	// DeferredToolFailed is the call whose tool raised or exited nonzero in a
	// way the tool itself reports as a failure.
	DeferredToolFailed DeferredToolCallState = "failed"
	// DeferredToolCancelled is the call the user withdrew.
	DeferredToolCancelled DeferredToolCallState = "cancelled"
	// DeferredToolTimedOut is the call that ran past its deadline.
	DeferredToolTimedOut DeferredToolCallState = "timed_out"
	// DeferredToolInterrupted is the call whose job died with the process that
	// ran it. The work is not continued: the round only says what happened.
	DeferredToolInterrupted DeferredToolCallState = "interrupted"
)

// DeferredToolCallActive reports whether a state still has work behind it.
func DeferredToolCallActive(state DeferredToolCallState) bool {
	return state == DeferredToolAccepted || state == DeferredToolRunning
}

// DeferredToolCall is one row of deferred_tool_calls.
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

// deferredToolCallPlaceholder is the tool_call_id of a row whose model call id
// is not known yet.
//
// It is the row id with a prefix, so a row is never mistaken for one the
// kernel bound, and a reader that only knows the row id can still name it.
func deferredToolCallPlaceholder(id string) string {
	return deferredToolCallPlaceholderPrefix + id
}

// deferredToolCallPlaceholderPrefix marks a tool_call_id the kernel has not
// bound yet.
const deferredToolCallPlaceholderPrefix = "deferred:"

// DeferredToolCallInput is one admitted call, ready to be recorded.
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

// RecordDeferredToolCall inserts one call, and reports the row that exists
// afterwards together with whether this call created it.
//
// The insert is the second of the three idempotency layers: a replay of the
// same request id finds the row that already exists instead of starting a
// second job.
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
	// The insert was ignored because one of the two unique keys already names
	// this call: the row that exists is the call, and no second job starts.
	existing := DeferredToolCallByRequestId(store, input.ConversationId, input.RequestId)
	if existing == nil {
		Raise("internal", "The deferred tool call could not be recorded")
	}
	return *existing, false
}

// DeferredToolCallById reads one call by its row id.
func DeferredToolCallById(store *TaskStore, id string) *DeferredToolCall {
	row := kernelRow(store.Db, "SELECT * FROM deferred_tool_calls WHERE id=?", id)
	return deferredToolCallRow(row)
}

// DeferredToolCallByRequestId reads one call by its idempotency key.
func DeferredToolCallByRequestId(store *TaskStore, conversationId, requestId string) *DeferredToolCall {
	row := kernelRow(store.Db, "SELECT * FROM deferred_tool_calls WHERE conversation_id IS ? AND request_id=?",
		nullableText(conversationId), requestId)
	return deferredToolCallRow(row)
}

// DeferredToolCallByModelCall reads one call by the id the model knows it by.
func DeferredToolCallByModelCall(store *TaskStore, conversationId, toolCallId string) *DeferredToolCall {
	row := kernelRow(store.Db, "SELECT * FROM deferred_tool_calls WHERE conversation_id IS ? AND tool_call_id=?",
		nullableText(conversationId), toolCallId)
	return deferredToolCallRow(row)
}

// DeferredToolCallByTaskCall reads one call inside a session that has no
// conversation.
func DeferredToolCallByTaskCall(store *TaskStore, taskId, nodeId, toolCallId string) *DeferredToolCall {
	row := kernelRow(store.Db, "SELECT * FROM deferred_tool_calls WHERE task_id=? AND node_id=? AND tool_call_id=?",
		taskId, nodeId, toolCallId)
	return deferredToolCallRow(row)
}

// DeferredToolCallsOfConversation lists the calls of one conversation, oldest
// first.
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

// LiveDeferredToolCallIds are the calls of one conversation that still have
// work behind them, keyed by the id the model knows them by.
//
// This is what keeps a deferred call `running` in the transcript when the turn
// that dispatched it ends: the call outlived the turn, so the turn's own
// closing must not declare it done.
func LiveDeferredToolCallIds(store *TaskStore, conversationId string) map[string]bool {
	live := map[string]bool{}
	for _, call := range DeferredToolCallsOfConversation(store, conversationId) {
		if DeferredToolCallActive(call.State) && !strings.HasPrefix(call.ToolCallId, deferredToolCallPlaceholderPrefix) {
			live[call.ToolCallId] = true
		}
	}
	return live
}

// MarkDeferredToolCallRunning records that the job began executing.
func MarkDeferredToolCallRunning(store *TaskStore, id string) {
	kernelExec(store.Db, "UPDATE deferred_tool_calls SET state='running' WHERE id=? AND state='accepted'", id)
}

// BindDeferredToolCallModelCall binds the id the kernel reported to the row
// that was admitted under a placeholder, and returns the row as it is now.
//
// The bind is one-way and idempotent: the first observation of the call wins,
// so a start event and a result event that both carry the id agree instead of
// fighting.
func BindDeferredToolCallModelCall(store *TaskStore, id, toolCallId string) *DeferredToolCall {
	if id != "" && toolCallId != "" {
		// The key is unique, so a call id that is already bound belongs to the
		// row that carries it: a replayed submission reaches the same call
		// instead of overwriting it with a second admission.
		if bound := DeferredToolCallByModelCall(store, conversationIdOfDeferredToolCall(store, id), toolCallId); bound != nil && bound.Id != id {
			return bound
		}
		kernelExec(store.Db, `UPDATE deferred_tool_calls SET tool_call_id=? WHERE id=? AND tool_call_id=?`,
			toolCallId, id, deferredToolCallPlaceholder(id))
	}
	return DeferredToolCallById(store, id)
}

// conversationIdOfDeferredToolCall reads the conversation one row belongs to.
func conversationIdOfDeferredToolCall(store *TaskStore, id string) string {
	if call := DeferredToolCallById(store, id); call != nil {
		return call.ConversationId
	}
	return ""
}

// FinishDeferredToolCall writes the terminal state of one call.
//
// It is the table's only terminal writer; the idempotency is in the WHERE
// clause, so a second settle of a call that already landed changes nothing and
// still returns the row that is there.
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

// DeferredToolCallsWithoutJob lists the calls that still claim to have work
// behind them while no job of this process owns them.
//
// After a restart this is every call the previous process was running; it is
// the whole input of the startup reconcile.
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

// deferredToolCallRow reads one row of the table.
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

// nullableText stores an empty string as SQL NULL, which is what a row without
// a conversation or without a summary carries.
func nullableText(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

// nullableInt stores a missing number as SQL NULL.
func nullableInt(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

// sqliteRowCount reads the rows a statement changed.
func sqliteRowCount(result sql.Result) int64 {
	rows, err := result.RowsAffected()
	if err != nil {
		return 0
	}
	return rows
}
