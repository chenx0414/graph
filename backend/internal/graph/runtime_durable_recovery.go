package graph

import (
	"encoding/json"
	"fmt"
	"sync"
)

type DurableRecoveryBinding struct {
	Config   map[string]any
	Callback func(string, map[string]any) (any, error)
	Close    func()
}

func durableStrings(value any) []string {
	body, _ := json.Marshal(value)
	var values []string
	if err := json.Unmarshal(body, &values); err != nil {
		panic(err)
	}
	return values
}

type durableCapture struct {
	captured chan AgentSessionRequest
	released chan struct{}
}

func (capture *durableCapture) Open(request AgentSessionRequest) (AgentSession, error) {
	capture.captured <- request
	<-capture.released
	return nil, fmt.Errorf("Original durable recovery binding closed")
}

func prepareDurableMainRecovery(options PiAdapterOptions, wrapper map[string]any) (*DurableRecoveryBinding, error) {
	snapshot := asMap(wrapper["snapshot"])
	id := mapString(snapshot, "executionId")
	lifecycle := NewOperationLifecycle(options.Store, OperationLifecycleHooks{})
	row := kernelRow(options.Store.Db, "SELECT * FROM operations WHERE id=?", id)
	if row == nil {
		return nil, nil
	}
	operation := operationFrom(row)
	if operation.Kind != "agent" || operationInstanceId(operation) != mapString(snapshot, "identity") {
		return nil, fmt.Errorf("Frozen main identity mismatch")
	}
	complete, _ := wrapper["completed"].(bool)
	original := mapString(snapshot, "originalInputRequestId")
	if original == "" {
		original = mapString(snapshot, "inputRequestId")
	}
	pre := durableStrings(snapshot["preAdmissionInvocationIds"])
	calls := []map[string]any{}
	for _, call := range kernelRows(options.Store.Db, "SELECT id,usage FROM invocations WHERE operation_id=?", id) {
		if !containsString(pre, kernelString(call["id"])) {
			calls = append(calls, call)
		}
	}
	if (!complete && len(calls) > 0) || original != fmt.Sprintf("%s:attempt:%d", id, operation.Attempt) || options.Store.Task(operation.TaskId).Phase != "chatting" {
		return nil, fmt.Errorf("Original durable admission has no safe recovery proof")
	}
	if kernelString(row["state"]) != "unknown" && kernelString(row["state"]) != "dispatched" {
		return nil, fmt.Errorf("Original durable operation is no longer pending")
	}
	lifecycle.transaction(func() any {
		kernelExec(options.Store.Db, "UPDATE operations SET state='dispatched',worker_active=1,waiting_slot=0 WHERE id=?", id)
		kernelExec(options.Store.Db, "UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND kind='recovery' AND status='open'", CanonicalJSON(map[string]any{"proof": "Original durable admission reattached", "inputRequestId": original}), id)
		CloseUserWaitForOperation(options.Store, id)
		kernelExec(options.Store.Db, "UPDATE nodes SET status='running' WHERE task_id=? AND id=? AND activation_id=?", operation.TaskId, operation.NodeId, operation.ActivationId)
		kernelExec(options.Store.Db, "UPDATE activations SET state='running' WHERE id=?", operation.ActivationId)
		return nil
	})
	capture := &durableCapture{captured: make(chan AgentSessionRequest, 1), released: make(chan struct{})}
	options.Transport = capture
	options.RecoverySnapshot = wrapper
	finished := make(chan error, 1)
	go func() {
		defer func() {
			if failure := recover(); failure != nil {
				finished <- fmt.Errorf("%v", failure)
			}
		}()
		adapter := CreatePiAdapter(options)
		result := adapter.Prepare(operation)()
		finished <- fmt.Errorf("Original main configuration could not be restored: %v", result.Output)
	}()
	var request AgentSessionRequest
	select {
	case request = <-capture.captured:
	case err := <-finished:
		return nil, err
	}
	callback := durableRequestCallback(request)
	var closeOnce sync.Once
	closeBinding := func() { closeOnce.Do(func() { close(capture.released); <-finished }) }
	return &DurableRecoveryBinding{Config: durableRequestConfig(request), Close: closeBinding, Callback: func(kind string, params map[string]any) (any, error) {
		if kind == "recovery_close" {
			closeBinding()
			return nil, nil
		}
		if kind == "recovery_complete" {
			body, _ := json.Marshal(params["turn"])
			var turn AgentSessionTurn
			if err := json.Unmarshal(body, &turn); err != nil {
				return nil, err
			}
			settledCalls := []map[string]any{}
			for _, call := range kernelRows(options.Store.Db, "SELECT id,usage FROM invocations WHERE operation_id=?", id) {
				if !containsString(pre, kernelString(call["id"])) {
					settledCalls = append(settledCalls, call)
				}
			}
			usage := sumKnownUsage(settledCalls)
			outcome := "completed"
			if turn.ErrorMessage != nil || (turn.StopReason != nil && (*turn.StopReason == "error" || *turn.StopReason == "aborted")) {
				outcome = "failed"
			}
			lifecycle.transaction(func() any {
				lifecycle.settle(operation, OperationResult{Outcome: outcome, Output: map[string]any{"text": turn.FinalAssistantText}, Usage: &usage}, operationSettleOptions{})
				return nil
			})
			return nil, nil
		}
		return callback(kind, params)
	}}, nil
}

func (runtime *TaskRuntime) bootstrapDurableRecovery() {
	if kernelRow(runtime.store.Db, "SELECT 1 FROM sqlite_master WHERE name='graph_durable_documents'") == nil {
		return
	}
	runtime.residentGraphLane()
	bindings := map[string]*DurableRecoveryBinding{}
	var mu sync.Mutex
	client, err := openDurableClient(runtime.store.Path, nil, func(kind string, params map[string]any) (any, error) {
		if kind == "restore_admission" {
			snapshot := asMap(params["snapshot"])
			id := mapString(snapshot, "executionId")
			var binding *DurableRecoveryBinding
			var err error
			if kernelRow(runtime.store.Db, "SELECT 1 FROM kernel_executions WHERE id=?", id) != nil {
				binding, err = PrepareDurableNodeRecovery(runtime.store.Path, params)
			} else {
				binding, err = prepareDurableMainRecovery(runtime.mainAdapterOptions(), params)
			}
			if err != nil {
				return nil, err
			}
			if binding == nil {
				return nil, nil
			}
			if completed, _ := params["completed"].(bool); completed && kernelRow(runtime.store.Db, "SELECT 1 FROM kernel_executions WHERE id=?", id) != nil {
				markDurableNodeCompletion(runtime.store.Path, id)
				kernelExec(runtime.store.Db, "UPDATE kernel_executions SET state='blocked' WHERE id=? AND state='failed'", id)
				execution := runtime.kernel.Execution(id)
				kernelExec(runtime.store.Db, "UPDATE kernel_queue SET state='queued',reason='Original completed SDK receipt retained for settlement' WHERE task_id=? AND node_id=? AND state='failed'", execution.TaskId, execution.NodeId)
			}
			mu.Lock()
			bindings[id] = binding
			mu.Unlock()
			return durablePublicConfig(binding.Config), nil
		}
		mu.Lock()
		binding := bindings[mapString(params, "executionId")]
		mu.Unlock()
		if binding == nil {
			return nil, fmt.Errorf("Original durable admission is not attached")
		}
		return binding.Callback(kind, params)
	})
	if err != nil {
		panic(err)
	}
	if err = client.call("recover", nil, nil); err != nil {
		_ = client.connection.Close()
		panic(err)
	}
	// This connection retains the original callbacks until the SDK owner closes.
}
