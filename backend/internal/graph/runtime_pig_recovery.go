package graph

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"context"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// bootstrapPigRecovery rebinds the Graph to the turns the kernel kept.
//
// The recovery runs before the daemon serves anything. A turn that has to be
// sent again must not wait for a daemon that is not up yet, and an operation
// that is already settled must not be dispatched a second time.
func (runtime *TaskRuntime) bootstrapPigRecovery(interruptedNodes []string) {
	pendingNodes := map[string]bool{}
	for _, id := range interruptedNodes {
		pendingNodes[id] = true
	}
	// The lane owns the restored configuration of a node, so it has to exist
	// before the recovery restores one.
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

// recoverPigExecution rebinds one frozen execution to its Graph operation.
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
		// The credential was spent and the side effects may have happened.
		// The operation stays unknown and the user reconciles it. The kernel's
		// own turn needs no stopping: the generation resumes from its
		// checkpoint, and a request the model already received is not
		// requested a second time.
	default:
		// A recovery that already failed is not tried again: the same send
		// would fail the same way after every boot, and the operation would
		// stay unknown for ever.
		if reason, failed := pigkernel.RecoveryFailure(execution.Record); failed {
			runtime.reportPigRecoveryBlocked(operation, reason)
			return
		}
		runtime.reattachPigExecution(operation, execution)
	}
}

// settlePigCompletion settles an operation from the kernel's own receipt.
//
// The kernel finished the turn; the Graph did not hear about it. The receipt
// is the proof, and the model is not asked again.
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

// reportPigRecoveryBlocked records that a recovery could not send a turn.
//
// The operation stays unknown - the turn may have reached the model - but the
// reason is durable and the user sees it, so the wait is a decision and not
// a silence.
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

// reattachPigExecution sends the interrupted turn again.
//
// The turn never reached the model, so nothing was spent and nothing
// happened. It runs with the configuration it was admitted with: the frozen
// model, the frozen policy and the original admission, so the kernel
// recognises the input it already accepted instead of admitting a second one.
//
// The turn runs in the background: the daemon must come up even when the
// model is slow, and the operation is unknown until the turn settles it.
func (runtime *TaskRuntime) reattachPigExecution(operation Operation, execution pigkernel.FrozenExecution) {
	// The attempt is recorded before it happens: a turn that is attempted and
	// fails must not be attempted again after the next boot.
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
	// The adapter records the admission and returns. The value is on the
	// capture when Prepare returns, so nothing races a closed channel.
	if !capture.opened || !capture.prompted {
		reason := "the interrupted turn could not be prepared" + pigRecoveryReason(prepared, preparedOk)
		runtime.markPigRecoveryFailure(execution, reason)
		reportPigRecoveryFailure(reason)
		return
	}
	go func() {
		defer catchPigRecoveryFailure("the interrupted turn could not be sent again")
		transport := CreatePigAgentSessionTransport(runtime.store, codemodeSettings(runtime.options.Codemode, runtime.stateDir))
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

// pigRecoveryReason names why the capture could not produce a turn.
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

// reportPigRecoveryFailure writes one recovery failure to the daemon's error
// stream.
//
// A recovery that fails silently reads like a turn that never happened: the
// operation stays unknown and nobody knows why.
func reportPigRecoveryFailure(reason string) {
	_, _ = os.Stderr.WriteString("pig kernel: " + reason + "\n")
}

// catchPigRecoveryFailure reports a recovery failure that panicked.
//
// The recovery runs in the background: a panic there would end the goroutine
// and leave the operation unknown with no trace of why.
func catchPigRecoveryFailure(reason string) {
	if failure := recover(); failure != nil {
		reportPigRecoveryFailure(reason + ": " + fmt.Sprintf("%v", failure))
	}
}

// settlePigTurn settles a recovered turn.
//
// The turn is the original one: the operation keeps its identity, its attempt
// and its budget, and only the outcome is new.
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

// markPigRecoveryFailure records that a recovery could not send a turn.
//
// The record is what the next boot reads: a recovery that already failed is
// not tried again, so the same doomed send does not run after every restart.
func (runtime *TaskRuntime) markPigRecoveryFailure(execution pigkernel.FrozenExecution, reason string) {
	func() {
		defer func() { _ = recover() }()
		_ = pigkernel.MarkRecoveryAttempt(context.Background(), runtime.store.Path, execution.ConversationId, reason)
	}()
}

// pigExecutionCalledProvider reports whether the execution reached the model.
//
// The frozen record names the invocations that existed before the execution
// started. An invocation beyond them is a provider call this execution made,
// and the turn must not be replayed.
func pigExecutionCalledProvider(store *TaskStore, operation Operation, execution pigkernel.FrozenExecution) bool {
	seen := []string{}
	for _, call := range kernelRows(store.Db, "SELECT id FROM invocations WHERE operation_id=?", operation.Id) {
		seen = append(seen, kernelString(call["id"]))
	}
	return pigCallsBeyond(frozenExecutionOfRecord(execution.Record).PreAdmissionInvocationIds, seen)
}

// pigRecoveryCapture records the admission the adapter would open.
//
// The PiG kernel lives in this process, so the recovery opens the real
// session itself. The capture keeps the request and the prompt, and its
// prompt tells the adapter to stop before a turn is sent.
type pigRecoveryCapture struct {
	request  AgentSessionRequest
	prompt   string
	opened   bool
	prompted bool
}

// Open records the session the adapter would open.
func (capture *pigRecoveryCapture) Open(request AgentSessionRequest) (AgentSession, error) {
	capture.request = request
	capture.opened = true
	return &pigRecoverySession{capture: capture}, nil
}

// pigRecoverySession is the session the capture hands back.
//
// It records the input the adapter would have sent and answers nothing: the
// real turn runs on the PiG kernel, in the recovery's own goroutine.
type pigRecoverySession struct {
	capture *pigRecoveryCapture
}

// Prompt records the input the adapter would send and stops the adapter.
//
// The stop reason is the signal that this was a recording, not a turn. The
// adapter returns the admission instead of settling an empty answer.
func (session *pigRecoverySession) Prompt(text string, images []ImageContent) (AgentSessionTurn, error) {
	session.capture.prompt = text
	session.capture.prompted = true
	return AgentSessionTurn{StopReason: stringPointer("admitted")}, nil
}

// Compact does nothing.
func (session *pigRecoverySession) Compact(instructions string) error { return nil }

// Steer does nothing.
func (session *pigRecoverySession) Steer(text string) error { return nil }

// Interrupt does nothing.
func (session *pigRecoverySession) Interrupt(text *string) error { return nil }

// Stop does nothing.
func (session *pigRecoverySession) Stop() error { return nil }

// Inspect reports an empty session.
func (session *pigRecoverySession) Inspect() AgentSessionInspect { return AgentSessionInspect{} }

// Close does nothing.
func (session *pigRecoverySession) Close() error { return nil }

// pigFrozenExecution is the durable record of one PiG execution.
//
// The record is what the recovery reads after a crash: which execution the
// kernel was running, the model it was admitted with and the input it was
// waiting for. The credential never enters it: the daemon keeps the live
// binding, and the record only names the headers it may restore.
func pigFrozenExecution(request AgentSessionRequest, preAdmission []string) map[string]any {
	return frozenExecutionRecord(frozenExecutionOfRequest(request, preAdmission))
}

// pigNestedMap reads one nested object of a frozen record.
//
// The object is read in place, not copied: a frozen record that is copied is a
// frozen record whose edits are lost.
func pigNestedMap(record map[string]any, key string) map[string]any {
	nested, _ := record[key].(map[string]any)
	return nested
}

// pigCredentialHeaders removes the credential headers of one frozen model.
//
// A frozen record outlives the process that wrote it, so a credential never
// enters it. The header names are returned instead: the recovery restores the
// values from the daemon's live binding.
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
