package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	deferredToolDefaultTimeoutMs = 120_000
	deferredToolShutdownGraceMs = 5_000
)

type deferredToolJob struct {
	id     string
	signal *AbortSignal
	gate   SendGate
	callId  string
	done    chan struct{}
	mutex   sync.Mutex
	cancel  bool
	expired bool
}

func (job *deferredToolJob) markCancelled() {
	job.mutex.Lock()
	job.cancel = true
	job.mutex.Unlock()
}

func (job *deferredToolJob) markExpired() {
	job.mutex.Lock()
	job.expired = true
	job.mutex.Unlock()
}

func (job *deferredToolJob) cancelled() bool {
	job.mutex.Lock()
	defer job.mutex.Unlock()
	return job.cancel
}

func (job *deferredToolJob) deadlinePassed() bool {
	job.mutex.Lock()
	defer job.mutex.Unlock()
	return job.expired
}

var deferredToolJobs = struct {
	mutex sync.Mutex
	jobs  map[string]*deferredToolJob
}{jobs: map[string]*deferredToolJob{}}

func registerDeferredToolJob(job *deferredToolJob) {
	deferredToolJobs.mutex.Lock()
	defer deferredToolJobs.mutex.Unlock()
	deferredToolJobs.jobs[job.id] = job
}

func releaseDeferredToolJob(id string) {
	deferredToolJobs.mutex.Lock()
	defer deferredToolJobs.mutex.Unlock()
	delete(deferredToolJobs.jobs, id)
}

func deferredToolJobOwned(id string) bool {
	deferredToolJobs.mutex.Lock()
	defer deferredToolJobs.mutex.Unlock()
	return deferredToolJobs.jobs[id] != nil
}

func deferredToolJobOf(id string) *deferredToolJob {
	deferredToolJobs.mutex.Lock()
	defer deferredToolJobs.mutex.Unlock()
	return deferredToolJobs.jobs[id]
}

type deferredToolTarget struct {
	TaskId         string
	NodeId         string
	ConversationId string
}

func deferredToolTargetOf(store *TaskStore, executionId string) (deferredToolTarget, bool) {
	if strings.TrimSpace(executionId) == "" {
		return deferredToolTarget{}, false
	}
	row := kernelRow(store.Db, `SELECT o.task_id, o.node_id, t.conversation_id
    FROM operations o JOIN tasks t ON t.id=o.task_id WHERE o.id=?`, executionId)
	if row == nil {
		return deferredToolTarget{}, false
	}
	target := deferredToolTarget{
		TaskId: kernelString(row["task_id"]), NodeId: kernelString(row["node_id"]),
	}
	if row["conversation_id"] != nil {
		target.ConversationId = kernelString(row["conversation_id"])
	}
	return target, target.TaskId != ""
}

func admitDeferredCall(store *TaskStore, request AgentSessionRequest, definition ToolDefinition, params map[string]any) (any, error) {
	if store == nil {
		return nil, errors.New("the daemon has no store to record a background call in")
	}
	callId := graphUUID()
	var failure error
	receipt := piWorkerAdmitWithoutSettle(request.Broker, callId, func() any {
		value, err := admitDeferredToolCall(deferredToolAdmission{
			Store: store, Request: request, Definition: definition, Params: params,
			Gate: request.Broker, CallId: callId,
		})
		failure = err
		return value
	})
	if failure != nil {
		return nil, failure
	}
	return receipt, nil
}

type deferredToolAdmission struct {
	Store      *TaskStore
	Request    AgentSessionRequest
	Definition ToolDefinition
	Params     map[string]any
	Gate       SendGate
	CallId string
}

func admitDeferredToolCall(input deferredToolAdmission) (any, error) {
	target, ok := deferredToolTargetOf(input.Store, input.Request.ExecutionId)
	if !ok {
		return nil, fmt.Errorf("the background call has no execution to belong to")
	}
	requestId := deferredToolRequestId(input.Params, input.CallId)
	if existing := DeferredToolCallByRequestId(input.Store, target.ConversationId, requestId); existing == nil {
		if err := DeferredToolCallSlot(input.Store, target.ConversationId); err != nil {
			return nil, err
		}
	}
	digest := CanonicalJSON(input.Params)
	now := NowMillis()
	budget := deferredToolBudgetMs(input.Params)
	deadline := now + int64(budget)
	row, created := RecordDeferredToolCall(input.Store, DeferredToolCallInput{
		TaskId: target.TaskId, ConversationId: target.ConversationId, NodeId: target.NodeId,
		ExecutionId: input.Request.ExecutionId, OperationId: input.Request.ExecutionId,
		ToolName: input.Definition.Name, RequestId: requestId, RequestDigest: digest,
		Args:    input.Definition.Name + " " + summarizeToolCall(input.Definition.Name, input.Params),
		Summary: summarizeToolCall(input.Definition.Name, input.Params), StartedAt: now, DeadlineAt: &deadline,
	})
	if !created {
		if row.RequestDigest != digest {
			return nil, fmt.Errorf("requestId %s was already used with different arguments; a deferred call is never reinterpreted", requestId)
		}
		MarkDeferredToolCallRunning(input.Store, row.Id)
		return deferredToolReceipt(row), nil
	}
	registerDeferredToolStart(input.Request.ExecutionId, input.Definition.Name, input.Params, row.Id)
	MarkDeferredToolCallRunning(input.Store, row.Id)
	job := &deferredToolJob{id: row.Id, signal: NewAbortSignal(), gate: input.Gate, callId: input.CallId, done: make(chan struct{})}
	registerDeferredToolJob(job)
	go runDeferredToolJob(input, row, job, budget)
	return deferredToolReceipt(row), nil
}

var deferredToolStarts = struct {
	mutex sync.Mutex
	rows  map[string][]string
}{rows: map[string][]string{}}

func registerDeferredToolStart(executionId, toolName string, args map[string]any, id string) {
	key := deferredToolStartKey(executionId, toolName, args)
	deferredToolStarts.mutex.Lock()
	defer deferredToolStarts.mutex.Unlock()
	deferredToolStarts.rows[key] = append(deferredToolStarts.rows[key], id)
}

func claimDeferredToolStart(executionId, toolName string, args any) (string, bool) {
	body, _ := args.(map[string]any)
	key := deferredToolStartKey(executionId, toolName, body)
	deferredToolStarts.mutex.Lock()
	defer deferredToolStarts.mutex.Unlock()
	waiting := deferredToolStarts.rows[key]
	if len(waiting) == 0 {
		return "", false
	}
	id := waiting[0]
	if len(waiting) == 1 {
		delete(deferredToolStarts.rows, key)
	} else {
		deferredToolStarts.rows[key] = waiting[1:]
	}
	return id, true
}

func forgetDeferredToolStart(executionId, toolName string, args map[string]any, id string) {
	key := deferredToolStartKey(executionId, toolName, args)
	deferredToolStarts.mutex.Lock()
	defer deferredToolStarts.mutex.Unlock()
	waiting := deferredToolStarts.rows[key]
	kept := []string{}
	for _, candidate := range waiting {
		if candidate != id {
			kept = append(kept, candidate)
		}
	}
	if len(kept) == 0 {
		delete(deferredToolStarts.rows, key)
		return
	}
	deferredToolStarts.rows[key] = kept
}

func deferredToolStartKey(executionId, toolName string, args map[string]any) string {
	return executionId + "\x00" + toolName + "\x00" + CanonicalJSON(args)
}

func deferredToolReceipt(call DeferredToolCall) map[string]any {
	body := deferredToolReceiptBody(call)
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": CanonicalJSON(body)}},
		"details": body,
	}
}

func deferredToolReceiptBody(call DeferredToolCall) map[string]any {
	return map[string]any{
		"status": "accepted", "state": string(DeferredToolRunning),
		"toolCallId": call.ToolCallId, "deferredId": call.Id, "requestId": call.RequestId,
		"operationId": call.OperationId,
		"text":        "已在后台执行，结果会作为后续消息到达；不要重复调用。",
	}
}

func deferredToolRequestId(params map[string]any, callId string) string {
	if value, ok := params["requestId"].(string); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return callId
}

func deferredToolBudgetMs(params map[string]any) int {
	requested := int(asFloatValue(params["timeout"]))
	if requested <= 0 {
		return deferredToolDefaultTimeoutMs
	}
	if requested > maxBashTimeoutMs {
		return maxBashTimeoutMs
	}
	return requested
}

func deferredToolWantsBackground(definition ToolDefinition, params map[string]any) bool {
	if definition.Deferred == nil {
		return false
	}
	if definition.Async {
		return true
	}
	value, _ := params["async"].(bool)
	return value
}

func runDeferredToolJob(input deferredToolAdmission, call DeferredToolCall, job *deferredToolJob, budgetMs int) {
	defer close(job.done)
	defer releaseDeferredToolJob(call.Id)
	defer forgetDeferredToolStart(input.Request.ExecutionId, input.Definition.Name, input.Params, call.Id)
	defer func() { _ = recover() }()
	timer := time.AfterFunc(time.Duration(budgetMs)*time.Millisecond, func() {
		job.markExpired()
		job.signal.Abort()
	})
	defer timer.Stop()
	value, err, raised := runDeferredToolBody(input, job)
	outcome := deferredToolOutcome{Gate: job.gate, GateCallId: job.callId}
	switch {
	case job.cancelled():
		outcome.State = DeferredToolCancelled
		outcome.Reason = "cancelled by the user"
	case job.deadlinePassed() || deferredToolDeadlineReached(call, budgetMs):
		outcome.State = DeferredToolTimedOut
		outcome.Reason = fmt.Sprintf("the call exceeded its %dms deadline", budgetMs)
	case raised != nil:
		outcome.State = DeferredToolFailed
		outcome.Reason = deferredToolPanicReason(raised)
	case err != nil:
		outcome.State = DeferredToolFailed
		outcome.Reason = err.Error()
	default:
		outcome.State = DeferredToolSettled
		outcome.Result = ToolResultText(value, 8_000)
	}
	finalizeDeferredToolCall(input.Store, call, outcome)
}

func runDeferredToolBody(input deferredToolAdmission, job *deferredToolJob) (value any, err error, raised any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			raised = recovered
		}
	}()
	value, err = input.Definition.Deferred(input.CallId, input.Params, job.signal)
	return value, err, nil
}

func deferredToolPanicReason(raised any) string {
	switch failure := raised.(type) {
	case *RuntimeError:
		return failure.Message
	case error:
		return failure.Error()
	default:
		return fmt.Sprint(raised)
	}
}

func RecoverDeferredToolCalls(store *TaskStore) int {
	if store == nil {
		return 0
	}
	orphans := DeferredToolCallsWithoutJob(store, deferredToolJobOwned)
	for _, call := range orphans {
		finalizeDeferredToolCall(store, call, deferredToolOutcome{
			State:  DeferredToolInterrupted,
			Reason: "the daemon restarted while the call was running; its result is unknown",
		})
	}
	return len(orphans)
}

func deferredToolProtocolState(state DeferredToolCallState) string {
	switch state {
	case DeferredToolAccepted, DeferredToolRunning:
		return "running"
	default:
		return string(state)
	}
}

func deferredToolReceiptOf(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "{") {
		return "", false
	}
	record := map[string]any{}
	if err := json.Unmarshal([]byte(trimmed), &record); err != nil {
		return "", false
	}
	if record["status"] != "accepted" {
		return "", false
	}
	id, _ := record["deferredId"].(string)
	if id == "" {
		return "", false
	}
	return id, true
}
