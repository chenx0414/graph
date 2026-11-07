package graph

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"context"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

func (runtime *TaskRuntime) bootstrapPigRecovery(interruptedNodes []string) {
	pendingNodes := map[string]bool{}
	for _, id := range interruptedNodes {
		pendingNodes[id] = true
	}
	runtime.residentGraphLane()
	executions, err := pigkernel.FrozenExecutions(context.Background(), runtime.store.Path)
	if err != nil {
		panic(fmt.Errorf("pig kernel: the frozen executions are not readable: %w", err))
	}
	for _, execution := range executions {
		if runtime.kernel.Execution(execution.ExecutionId) != nil && !pendingNodes[execution.ExecutionId] {
			continue
		}
		if runtime.recoverPigNodeExecution(execution) {
			continue
		}
		runtime.recoverPigExecution(execution)
	}
}

func (runtime *TaskRuntime) abortStalledMasterTurns() int {
	rows := kernelRows(runtime.store.Db, `SELECT n.task_id, n.instance_id FROM nodes n
        JOIN conversations c ON c.anchor_task_id = n.task_id
        WHERE n.id='master' AND c.archived_at IS NULL`)
	aborted := 0
	for _, row := range rows {
		instance := kernelString(row["instance_id"])
		if instance == "" {
			continue
		}
		did, err := pigkernel.AbortStalledConversation(context.Background(), runtime.store.Path, instance)
		if err != nil {
			reportPigRecoveryFailure("the stalled turn could not be aborted: " + err.Error())
			continue
		}
		if !did {
			continue
		}
		aborted++
		runtime.store.Event(kernelString(row["task_id"]), "graph.recovery.stalled_turn_aborted", map[string]any{
			"reason": "a tool interrupted mid-execution cannot be replayed; the conversation was aborted so later turns can run",
		})
	}
	if aborted > 0 && runtime.autoWake {
		runtime.execution.Kick()
	}
	return aborted
}

func (runtime *TaskRuntime) dispatchQueuedMasterMessages() int {
	rows := kernelRows(runtime.store.Db, `SELECT DISTINCT c.anchor_task_id FROM conversations c
        JOIN messages m ON m.conversation_id = c.id
        WHERE c.archived_at IS NULL AND m.role='user' AND m.state IN ('pending','queued')`)
	released := 0
	for _, row := range rows {
		if RecoverMaster(runtime.store, kernelString(row["anchor_task_id"]), "message") {
			released++
		}
	}
	if len(rows) > 0 && runtime.autoWake {
		runtime.execution.Kick()
	}
	return released
}

func (runtime *TaskRuntime) recoverPigExecution(execution pigkernel.FrozenExecution) {
	if execution.ExecutionId == "" || execution.Identity == "" || execution.InputRequestId == "" {
		return
	}
	row := kernelRow(runtime.store.Db, "SELECT * FROM operations WHERE id=?", execution.ExecutionId)
	if row == nil {
		return
	}
	state := kernelString(row["state"])
	if state != "unknown" && state != "dispatched" {
		return
	}
	operation := operationFrom(row)
	if operation.Kind != "agent" || operationInstanceId(operation) != execution.Identity {
		return
	}
	receipt, err := pigkernel.ReadExecutionReceipt(context.Background(), runtime.store.Path, execution)
	if err != nil {
		panic(fmt.Errorf("pig kernel: the admission of %s is not readable: %w", execution.ExecutionId, err))
	}
	switch classifyPigTurn(receipt, pigExecutionCalledProvider(runtime.store, operation, execution)) {
	case pigTurnKernelDone:
		runtime.settlePigCompletion(operation, execution, receipt)
	case pigTurnReachedModel:
	default:
		if reason, failed := pigkernel.RecoveryFailure(execution.Record); failed {
			runtime.reportPigRecoveryBlocked(operation, reason)
			return
		}
		runtime.reattachPigExecution(operation, execution)
	}
}

func (runtime *TaskRuntime) settlePigCompletion(operation Operation, execution pigkernel.FrozenExecution, receipt pigkernel.ExecutionReceipt) {
	lifecycle := NewOperationLifecycle(runtime.store, OperationLifecycleHooks{})
	lifecycle.acceptDurableCompletion(durableCompletion{
		ExecutionId:               execution.ExecutionId,
		Identity:                  execution.Identity,
		InputRequestId:            execution.InputRequestId,
		PreAdmissionInvocationIds: frozenExecutionOfRecord(execution.Record).PreAdmissionInvocationIds,
		FinalAssistantText:        receipt.Text,
		StopReason:                receipt.StopReason,
	})
}

func (runtime *TaskRuntime) reportPigRecoveryBlocked(operation Operation, reason string) {
	message := "The interrupted turn could not be sent again: " + reason
	runtime.store.Transaction(func() any {
		runtime.store.Event(operation.TaskId, "graph.recovery.blocked", map[string]any{
			"operationId": operation.Id, "nodeId": operation.NodeId, "reason": message,
		})
		return nil
	})
	reportPigRecoveryFailure(message)
}

func (runtime *TaskRuntime) reattachPigExecution(operation Operation, execution pigkernel.FrozenExecution) {
	runtime.store.Transaction(func() any {
		runtime.store.Event(operation.TaskId, "graph.recovery.attempted", map[string]any{
			"operationId": operation.Id, "nodeId": operation.NodeId,
		})
		return nil
	})
	wrapper := frozenExecutionRecovery(frozenExecutionOfRecord(execution.Record), execution.Identity)
	capture := &pigRecoveryCapture{}
	options := runtime.mainAdapterOptions()
	options.Transport = capture
	options.RecoverySnapshot = wrapper
	var prepared OperationResult
	var preparedOk bool
	func() {
		defer catchPigRecoveryFailure("the interrupted turn could not be prepared")
		prepared = CreatePiAdapter(options).Prepare(operation)()
		preparedOk = true
	}()
	if !capture.opened || !capture.prompted {
		reason := "the interrupted turn could not be prepared" + pigRecoveryReason(prepared, preparedOk)
		runtime.markPigRecoveryFailure(execution, reason)
		reportPigRecoveryFailure(reason)
		return
	}
	go func() {
		defer catchPigRecoveryFailure("the interrupted turn could not be sent again")
		transport := CreatePigAgentSessionTransport(runtime.store, codemodeSettings(runtime.options.Codemode, runtime.stateDir))
		capture.request.Recovering = true
		session, err := transport.Open(capture.request)
		if err != nil {
			reason := "the interrupted turn could not be opened: " + err.Error()
			runtime.markPigRecoveryFailure(execution, reason)
			reportPigRecoveryFailure(reason)
			return
		}
		defer func() { _ = session.Close() }()
		turn, err := session.Prompt(capture.prompt, nil)
		if err != nil {
			reason := "the interrupted turn could not be sent again: " + err.Error()
			runtime.markPigRecoveryFailure(execution, reason)
			reportPigRecoveryFailure(reason)
			return
		}
		runtime.settlePigTurn(operation, turn)
	}()
}

func pigRecoveryReason(result OperationResult, ok bool) string {
	if !ok || result.Outcome == "" || result.Outcome == "completed" {
		return ""
	}
	message := ""
	if output := asMap(result.Output); output != nil {
		for _, key := range turnFailureOutputKeys {
			if value, ok := output[key].(string); ok && strings.TrimSpace(value) != "" {
				message = value
				break
			}
		}
	}
	if message == "" {
		return ": " + result.Outcome
	}
	return ": " + message
}

func reportPigRecoveryFailure(reason string) {
	_, _ = os.Stderr.WriteString("pig kernel: " + reason + "\n")
}

func catchPigRecoveryFailure(reason string) {
	if failure := recover(); failure != nil {
		reportPigRecoveryFailure(reason + ": " + fmt.Sprintf("%v", failure))
	}
}

func (runtime *TaskRuntime) settlePigTurn(operation Operation, turn AgentSessionTurn) {
	usage := TokenUsage{}
	if turn.Usage != nil {
		usage = TokenUsage{
			Input: int64(turn.Usage.Input), Output: int64(turn.Usage.Output),
			CacheRead: int64(turn.Usage.CacheRead), CacheWrite: int64(turn.Usage.CacheWrite),
		}
	}
	outcome := "completed"
	if turn.ErrorMessage != nil || (turn.StopReason != nil && (*turn.StopReason == "error" || *turn.StopReason == "aborted")) {
		outcome = "failed"
	}
	lifecycle := NewOperationLifecycle(runtime.store, OperationLifecycleHooks{})
	lifecycle.settle(operation, OperationResult{
		Outcome: outcome,
		Output:  map[string]any{"text": turn.FinalAssistantText},
		Usage:   &usage,
	}, operationSettleOptions{})
}

func (runtime *TaskRuntime) markPigRecoveryFailure(execution pigkernel.FrozenExecution, reason string) {
	func() {
		defer func() { _ = recover() }()
		_ = pigkernel.MarkRecoveryAttempt(context.Background(), runtime.store.Path, execution.ConversationId, reason)
	}()
}

func pigExecutionCalledProvider(store *TaskStore, operation Operation, execution pigkernel.FrozenExecution) bool {
	seen := []string{}
	for _, call := range kernelRows(store.Db, "SELECT id FROM invocations WHERE operation_id=?", operation.Id) {
		seen = append(seen, kernelString(call["id"]))
	}
	return pigCallsBeyond(frozenExecutionOfRecord(execution.Record).PreAdmissionInvocationIds, seen)
}

type pigRecoveryCapture struct {
	request  AgentSessionRequest
	prompt   string
	opened   bool
	prompted bool
}

func (capture *pigRecoveryCapture) Open(request AgentSessionRequest) (AgentSession, error) {
	capture.request = request
	capture.opened = true
	return &pigRecoverySession{capture: capture}, nil
}

type pigRecoverySession struct {
	capture *pigRecoveryCapture
}

func (session *pigRecoverySession) Prompt(text string, images []ImageContent) (AgentSessionTurn, error) {
	session.capture.prompt = text
	session.capture.prompted = true
	return AgentSessionTurn{StopReason: stringPointer("admitted")}, nil
}

func (session *pigRecoverySession) Compact(instructions string) error { return nil }

func (session *pigRecoverySession) Steer(text string) error { return nil }

func (session *pigRecoverySession) Interrupt(text *string) error { return nil }

func (session *pigRecoverySession) Stop() error { return nil }

func (session *pigRecoverySession) Inspect() AgentSessionInspect { return AgentSessionInspect{} }

func (session *pigRecoverySession) Close() error { return nil }

func pigFrozenExecution(request AgentSessionRequest, preAdmission []string) map[string]any {
	return frozenExecutionRecord(frozenExecutionOfRequest(request, preAdmission))
}

func pigNestedMap(record map[string]any, key string) map[string]any {
	nested, _ := record[key].(map[string]any)
	return nested
}

func pigCredentialHeaders(model map[string]any) []string {
	if model == nil {
		return nil
	}
	headers := asMap(model["headers"])
	if headers == nil {
		return nil
	}
	names := []string{}
	for name := range headers {
		if !isCredentialHeader(name) {
			continue
		}
		names = append(names, name)
		delete(headers, name)
	}
	if len(names) == 0 {
		return nil
	}
	model["headers"] = headers
	sort.Strings(names)
	return names
}
