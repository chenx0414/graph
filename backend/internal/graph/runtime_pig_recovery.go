package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"sync"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// The PiG kernel's crash recovery.
//
// The daemon may die while a turn is running. What can be recovered follows
// from three facts, and the kernel keeps all three:
//
//   - A turn the kernel finished is a receipt. The Graph settles the operation
//     from it, and the model is not asked again.
//   - A turn that never reached the model is sent again, with the
//     configuration it was admitted with, not the configuration the catalog
//     happens to hold now.
//   - A turn that was already at the model is neither. The credential was
//     spent and the side effects may have happened, so the operation waits
//     for the user to reconcile it.
//
// The frozen execution ties the three together: it names the Graph
// execution, the admission it was waiting for and the configuration it was
// admitted with.

// bootstrapPigRecovery rebinds the Graph to the turns the kernel kept.
//
// The recovery runs before the daemon serves anything. A turn that has to be
// sent again must not wait for a daemon that is not up yet, and an operation
// that is already settled must not be dispatched a second time.
func (runtime *TaskRuntime) bootstrapPigRecovery() {
	executions, err := pigkernel.FrozenExecutions(context.Background(), runtime.store.Path)
	if err != nil {
		panic(fmt.Errorf("pig kernel: the frozen executions are not readable: %w", err))
	}
	for _, execution := range executions {
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
	if receipt.Completed {
		runtime.settlePigCompletion(operation, execution, receipt)
		return
	}
	// A turn that reached the model is not replayed: the credential was spent
	// and the side effects may have happened. The operation stays unknown and
	// the user reconciles it.
	if pigExecutionCalledProvider(runtime.store, operation, execution) {
		return
	}
	runtime.reattachPigExecution(operation, execution)
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
		PreAdmissionInvocationIds: durableStrings(execution.Record["preAdmissionInvocationIds"]),
		FinalAssistantText:        receipt.Text,
		StopReason:                receipt.StopReason,
	})
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
	wrapper := map[string]any{
		"snapshot":           execution.Record,
		"restoredPolicy":     asMap(execution.Record["policy"]),
		"restoredDescriptor": asMap(asMap(execution.Record["configuration"])["descriptor"]),
	}
	capture := &pigRecoveryCapture{
		request: make(chan AgentSessionRequest, 1),
		prompt:  make(chan string, 1),
	}
	options := runtime.mainAdapterOptions()
	options.Transport = capture
	options.RecoverySnapshot = wrapper
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		defer catchPigRecoveryFailure("the interrupted turn could not be prepared")
		adapter := CreatePiAdapter(options)
		_ = adapter.Prepare(operation)()
	}()
	var request AgentSessionRequest
	select {
	case request = <-capture.request:
	case <-finished:
		return
	}
	var text string
	select {
	case text = <-capture.prompt:
	case <-finished:
		return
	}
	go func() {
		defer catchPigRecoveryFailure("the interrupted turn could not be sent again")
		transport := CreatePigAgentSessionTransport(runtime.store, codemodeSettings(runtime.options.Codemode, runtime.stateDir))
		session, err := transport.Open(request)
		if err != nil {
			reportPigRecoveryFailure("the interrupted turn could not be opened: " + err.Error())
			return
		}
		defer func() { _ = session.Close() }()
		turn, err := session.Prompt(text, nil)
		if err != nil {
			reportPigRecoveryFailure("the interrupted turn could not be sent again: " + err.Error())
			return
		}
		runtime.settlePigTurn(operation, turn)
	}()
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

// pigExecutionCalledProvider reports whether the execution reached the model.
//
// The frozen record names the invocations that existed before the execution
// started. An invocation beyond them is a provider call this execution made,
// and the turn must not be replayed.
func pigExecutionCalledProvider(store *TaskStore, operation Operation, execution pigkernel.FrozenExecution) bool {
	pre := map[string]bool{}
	for _, id := range durableStrings(execution.Record["preAdmissionInvocationIds"]) {
		pre[id] = true
	}
	for _, call := range kernelRows(store.Db, "SELECT id FROM invocations WHERE operation_id=?", operation.Id) {
		if !pre[kernelString(call["id"])] {
			return true
		}
	}
	return false
}

// pigRecoveryCapture catches the session an adapter would open.
//
// The PiG kernel lives in this process, so the recovery opens the session
// itself and replays the turn. The capture records what the adapter built -
// the request and the input it would have sent - and hands back a session
// that does nothing.
type pigRecoveryCapture struct {
	request chan AgentSessionRequest
	prompt  chan string
	once    sync.Once
}

// Open records the session the adapter would open.
func (capture *pigRecoveryCapture) Open(request AgentSessionRequest) (AgentSession, error) {
	capture.once.Do(func() { capture.request <- request })
	return &pigRecoverySession{capture: capture}, nil
}

// pigRecoverySession is the session the capture hands back.
//
// It records the input the adapter would have sent and answers nothing: the
// real turn runs on the PiG kernel, in the recovery's own goroutine.
type pigRecoverySession struct {
	capture *pigRecoveryCapture
}

// Prompt records the input the adapter would send.
func (session *pigRecoverySession) Prompt(text string, images []ImageContent) (AgentSessionTurn, error) {
	select {
	case session.capture.prompt <- text:
	default:
	}
	return AgentSessionTurn{}, nil
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
	model := map[string]any{}
	if view, ok := request.Model.(piModelView); ok {
		body, _ := json.Marshal(view)
		_ = json.Unmarshal(body, &model)
	} else if record := asMap(request.Model); record != nil {
		model = record
	}
	configuration := map[string]any{}
	if request.ExecutionConfiguration != nil {
		body, _ := json.Marshal(request.ExecutionConfiguration)
		_ = json.Unmarshal(body, &configuration)
	}
	credential := map[string]any{}
	if request.CredentialReference != nil {
		body, _ := json.Marshal(request.CredentialReference)
		_ = json.Unmarshal(body, &credential)
	}
	// The credential headers never enter the durable record: the daemon owns
	// the live binding, and the record only names the headers it may restore.
	names := map[string]bool{}
	for _, header := range []map[string]any{model, pigNestedMap(configuration, "model")} {
		for _, name := range pigCredentialHeaders(header) {
			names[name] = true
		}
	}
	credentials := []string{}
	for name := range names {
		credentials = append(credentials, name)
	}
	sort.Strings(credentials)
	policy := map[string]any{
		"workspace":           request.Workspace,
		"stateDir":            request.StateDir,
		"skillPaths":          request.SkillPaths,
		"skillFolder":         request.SkillFolder,
		"piExtensionPaths":    request.PiExtensionPaths,
		"readRoots":           request.ReadRoots,
		"writeRoots":          request.WriteRoots,
		"protectedPaths":      request.ProtectedPaths,
		"filesystemAccess":    request.FilesystemAccess,
		"nativeTools":         request.NativeTools,
		"allowedToolNames":    request.AllowedToolNames,
		"bundleDigest":        request.BundleDigest,
		"toolPolicyDigest":    request.ToolPolicyDigest,
		"runtimePolicyDigest": request.RuntimePolicyDigest,
		"thinkingLevel":       request.ThinkingLevel,
	}
	tools := []map[string]any{}
	for _, tool := range request.Tools {
		tools = append(tools, map[string]any{
			"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters,
		})
	}
	record := map[string]any{
		"identity":                  request.Binding.InstanceId,
		"executionId":               request.ExecutionId,
		"inputRequestId":            request.InputRequestId,
		"preAdmissionInvocationIds": preAdmission,
		"model":                     model,
		"agent": map[string]any{
			"model":        model,
			"instructions": request.SystemPrompt,
			"cwd":          request.Workspace,
		},
		"extensionName": pigkernel.ExtensionName(request.Binding.InstanceId),
		"tools":         tools,
		"policy":        policy,
		"configuration": map[string]any{
			"executionConfiguration": configuration,
			"credentialReference":    credential,
			"headerCredentials":      credentials,
			"descriptor":             request.CapabilityDescriptor,
		},
	}
	return record
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
