package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// The deferred tool call, from admission to job.
//
// A call that opts into the background is admitted where every other call is
// admitted - inside the running execution, through the same tool gate - and
// then handed to a job of the daemon's own. The job has its own context and
// its own abort signal, so it outlives the turn (and is stopped by the user,
// by its deadline, or by the process ending) without depending on either.
//
// The turn gets a receipt instead of a result: the model is told the call was
// accepted, that it must not repeat it, and that the outcome will arrive as a
// later message. That is what ends the turn, frees the node and lets the next
// message be answered while the command is still running.
const (
	// deferredToolDefaultTimeoutMs is how long a deferred call may run when the
	// model named no limit: the same 120s the command runner uses by default,
	// so "no limit given" means the same thing in both places.
	deferredToolDefaultTimeoutMs = 120_000
	// deferredToolShutdownGraceMs is the room the command gets to die after the
	// deadline fired. The deadline is the daemon's own clock; the runner's
	// limit is only the backstop that guarantees the process is gone.
	deferredToolShutdownGraceMs = 5_000
)

// deferredToolJob is one call's running work, in this process.
type deferredToolJob struct {
	id     string
	signal *AbortSignal
	gate   SendGate
	// callId is the id the tool gate admitted the call under; the settlement
	// of the gate ledger uses it.
	callId  string
	done    chan struct{}
	mutex   sync.Mutex
	cancel  bool
	expired bool
}

// markCancelled records that the user withdrew the call.
func (job *deferredToolJob) markCancelled() {
	job.mutex.Lock()
	job.cancel = true
	job.mutex.Unlock()
}

// markExpired records that the call ran past its deadline.
func (job *deferredToolJob) markExpired() {
	job.mutex.Lock()
	job.expired = true
	job.mutex.Unlock()
}

// cancelled reports whether the user withdrew the call.
func (job *deferredToolJob) cancelled() bool {
	job.mutex.Lock()
	defer job.mutex.Unlock()
	return job.cancel
}

// expired reports whether the deadline fired.
func (job *deferredToolJob) deadlinePassed() bool {
	job.mutex.Lock()
	defer job.mutex.Unlock()
	return job.expired
}

// deferredToolJobs is the daemon's registry of the jobs this process runs.
//
// It is deliberately not durable: the durability is the row. A row whose job
// is not in this map is a call the process is not running, which is exactly
// what the startup reconcile needs to know.
var deferredToolJobs = struct {
	mutex sync.Mutex
	jobs  map[string]*deferredToolJob
}{jobs: map[string]*deferredToolJob{}}

// registerDeferredToolJob takes ownership of one call in this process.
func registerDeferredToolJob(job *deferredToolJob) {
	deferredToolJobs.mutex.Lock()
	defer deferredToolJobs.mutex.Unlock()
	deferredToolJobs.jobs[job.id] = job
}

// releaseDeferredToolJob gives up ownership of one call.
func releaseDeferredToolJob(id string) {
	deferredToolJobs.mutex.Lock()
	defer deferredToolJobs.mutex.Unlock()
	delete(deferredToolJobs.jobs, id)
}

// deferredToolJobOwned reports whether this process runs the call.
func deferredToolJobOwned(id string) bool {
	deferredToolJobs.mutex.Lock()
	defer deferredToolJobs.mutex.Unlock()
	return deferredToolJobs.jobs[id] != nil
}

// deferredToolJobOf reads one running job.
func deferredToolJobOf(id string) *deferredToolJob {
	deferredToolJobs.mutex.Lock()
	defer deferredToolJobs.mutex.Unlock()
	return deferredToolJobs.jobs[id]
}

// deferredToolTarget is the task, node and conversation one execution belongs
// to.
//
// The session request carries the execution and the instance; the row needs
// the conversation, the node and the task, and the operation ledger is where
// those facts live. A session whose execution has no operation (a probe, a
// test harness) has no conversation and no task, and its calls are not
// deferred.
type deferredToolTarget struct {
	TaskId         string
	NodeId         string
	ConversationId string
}

// deferredToolTargetOf reads where one execution belongs.
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

// admitDeferredCall admits one background call and returns the receipt the
// model reads.
//
// The admission is the same one a synchronous call passes - the tool gate,
// inside the running execution - so the budget reservation, the phase check
// and the pause check all happen now, while the turn that asked is still
// running. What changes is what follows: the work is handed to a job of the
// daemon's own and the gate is settled by that job when the work is over.
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

// deferredToolAdmission is one call asking to run in the background.
type deferredToolAdmission struct {
	Store      *TaskStore
	Request    AgentSessionRequest
	Definition ToolDefinition
	Params     map[string]any
	Gate       SendGate
	// CallId is the invocation the gate admits the call under.
	CallId string
}

// admitDeferredToolCall records the call and starts its job.
//
// It returns the receipt the model reads as the call's result. The receipt is
// what makes the turn endable: everything the model needs to know - that the
// call was accepted, under which id, and that the result arrives later - is in
// it, so the turn does not have to wait for the work.
func admitDeferredToolCall(input deferredToolAdmission) (any, error) {
	target, ok := deferredToolTargetOf(input.Store, input.Request.ExecutionId)
	if !ok {
		return nil, fmt.Errorf("the background call has no execution to belong to")
	}
	requestId := deferredToolRequestId(input.Params, input.CallId)
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
		// The third idempotency layer: the same request id names the same work.
		// Different arguments under one request id would be a second side effect
		// behind a name that already happened, so it is refused outright.
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

// deferredToolStarts are the admitted calls whose own tool call id the kernel
// has not reported yet.
//
// The kernel hands a tool its arguments only: the id the model knows the call
// by never reaches the tool body. The event stream has it, so the two meet
// here - the admission leaves the row under the key the event will describe,
// the event claims it and binds the id. The digest keeps a claim from matching
// a different call that merely used the same tool.
var deferredToolStarts = struct {
	mutex sync.Mutex
	rows  map[string][]string
}{rows: map[string][]string{}}

// registerDeferredToolStart leaves one admitted call waiting for its id.
func registerDeferredToolStart(executionId, toolName string, args map[string]any, id string) {
	key := deferredToolStartKey(executionId, toolName, args)
	deferredToolStarts.mutex.Lock()
	defer deferredToolStarts.mutex.Unlock()
	deferredToolStarts.rows[key] = append(deferredToolStarts.rows[key], id)
}

// claimDeferredToolStart takes the oldest admitted call that matches one
// starting tool call, and reports its row id.
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

// forgetDeferredToolStart drops one admitted call nobody claimed.
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

// deferredToolStartKey is the identity one starting event and one admission
// share.
func deferredToolStartKey(executionId, toolName string, args map[string]any) string {
	return executionId + "\x00" + toolName + "\x00" + CanonicalJSON(args)
}

// deferredToolReceipt is what the model reads as the result of a deferred call.
//
// It is the SDK's own tool result shape - the content the model reads and the
// details the console keeps - because that is what the kernel stores and what
// it reports back when the call ends. The content is the acceptance as JSON: a
// model reads "accepted, do not repeat" from it, and the daemon reads the call
// ids it carries out of it when the call's result event arrives.
func deferredToolReceipt(call DeferredToolCall) map[string]any {
	body := deferredToolReceiptBody(call)
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": CanonicalJSON(body)}},
		"details": body,
	}
}

// deferredToolReceiptBody is the acceptance the model reads.
func deferredToolReceiptBody(call DeferredToolCall) map[string]any {
	return map[string]any{
		"status": "accepted", "state": string(DeferredToolRunning),
		"toolCallId": call.ToolCallId, "deferredId": call.Id, "requestId": call.RequestId,
		// The frozen contract names the call's operation (design §3.1), and the
		// list endpoint reports the same value: a model that repeats the call
		// reads the same operation id it would see in GET .../tool-calls.
		"operationId": call.OperationId,
		"text":        "已在后台执行，结果会作为后续消息到达；不要重复调用。",
	}
}

// deferredToolRequestId is the idempotency key of one call: the model's own
// requestId when it named one, the invocation id otherwise.
func deferredToolRequestId(params map[string]any, callId string) string {
	if value, ok := params["requestId"].(string); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return callId
}

// deferredToolBudgetMs is how long the call may run.
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

// deferredToolWantsBackground reads whether one call asked to run in the
// background.
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

// runDeferredToolJob executes one admitted call and settles it.
//
// The job is the only place the work runs, and the only place the outcome is
// decided: a call the user withdrew, a call that ran past its deadline and a
// call whose tool raised are three readings of one exit, and they all leave
// through finalizeDeferredToolCall.
func runDeferredToolJob(input deferredToolAdmission, call DeferredToolCall, job *deferredToolJob, budgetMs int) {
	defer close(job.done)
	defer releaseDeferredToolJob(call.Id)
	defer forgetDeferredToolStart(input.Request.ExecutionId, input.Definition.Name, input.Params, call.Id)
	// A settle that cannot write leaves the row exactly as it was: the next
	// startup reconcile closes it. What it must not do is take the daemon with
	// it - a panic in a goroutine nobody joins ends the whole process.
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

// runDeferredToolBody runs the tool with the daemon's own signal and turns a
// refusal into a value instead of letting it escape the goroutine.
func runDeferredToolBody(input deferredToolAdmission, job *deferredToolJob) (value any, err error, raised any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			raised = recovered
		}
	}()
	value, err = input.Definition.Deferred(input.CallId, input.Params, job.signal)
	return value, err, nil
}

// deferredToolPanicReason is the one line a raised call reports.
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

// RecoverDeferredToolCalls closes the background calls this process is not
// running.
//
// After a restart every call the previous process was executing still says it
// is running, and nothing will ever finish it: the work died with the process.
// The rows this process owns a job for are the exception - a reconcile that
// runs while the daemon is up must not declare live work dead - and every
// other row is interrupted, with a reason and one wake, so the console stops
// showing a call that cannot end and the master learns the outcome is unknown.
//
// It needs no memory of the previous process: "no job here" is the whole test,
// and it is idempotent, so running it twice reports the same thing once.
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

// deferredToolProtocolState maps one row state onto the protocol's vocabulary.
//
// The states are the same words; this exists so a reader of the HTTP answer
// and a reader of the row cannot drift apart.
func deferredToolProtocolState(state DeferredToolCallState) string {
	switch state {
	case DeferredToolAccepted, DeferredToolRunning:
		return "running"
	default:
		return string(state)
	}
}

// deferredToolReceiptOf reads the deferred id a receipt carries.
//
// The kernel reports the tool's own result when the call ends; a result that
// is the daemon's receipt names the row, which is how the row learns the id
// the model knows the call by.
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
