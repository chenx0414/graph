package graph

import "fmt"

type durableCompletion struct {
	ExecutionId               string   `json:"executionId"`
	Identity                  string   `json:"identity"`
	InputRequestId            string   `json:"inputRequestId"`
	PreAdmissionInvocationIds []string `json:"preAdmissionInvocationIds"`
	FinalAssistantText        string   `json:"finalAssistantText"`
	StopReason                string   `json:"stopReason"`
}

// A completed SDK receipt can settle an interrupted main operation without
// another provider request or replaying any tool. Unknown usage stays unknown.
func recoverDurableCompletions(store *TaskStore) {
	if kernelRow(store.Db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_durable_documents'") == nil {
		return
	}
	if kernelRow(store.Db, "SELECT 1 FROM operations WHERE state IN ('unknown','dispatched') LIMIT 1") == nil {
		return
	}
	client, err := openDurableClient(store.Path, nil, func(string, map[string]any) (any, error) { return nil, fmt.Errorf("Passive recovery cannot execute") })
	if err != nil {
		panic(err)
	}
	defer client.connection.Close()
	var completed []durableCompletion
	if err = client.call("completed", nil, &completed); err != nil {
		panic(err)
	}
	lifecycle := NewOperationLifecycle(store, OperationLifecycleHooks{})
	for _, receipt := range completed {
		lifecycle.acceptDurableCompletion(receipt)
	}
}

func (lifecycle *OperationLifecycle) acceptDurableCompletion(receipt durableCompletion) {
	lifecycle.transaction(func() any {
		row := lifecycle.operationRow(receipt.ExecutionId)
		state := kernelString(row["state"])
		if state != "unknown" && state != "dispatched" {
			return nil
		}
		operation := operationFrom(row)
		if operation.Kind != "agent" || operationInstanceId(operation) != receipt.Identity || lifecycle.store.Task(operation.TaskId).Phase != "chatting" || receipt.InputRequestId != fmt.Sprintf("%s:attempt:%d", operation.Id, operation.Attempt) {
			Raise("invalid_reconciliation", "Completed durable input does not match its original main admission")
		}
		calls := []map[string]any{}
		for _, call := range kernelRows(lifecycle.store.Db, "SELECT id,usage FROM invocations WHERE operation_id=?", operation.Id) {
			if !containsString(receipt.PreAdmissionInvocationIds, kernelString(call["id"])) {
				calls = append(calls, call)
			}
		}
		usage := sumKnownUsage(calls)
		kernelExec(lifecycle.store.Db, "UPDATE operations SET state='dispatched',worker_active=1,waiting_slot=0 WHERE id=?", operation.Id)
		kernelExec(lifecycle.store.Db, "UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND kind='recovery' AND status='open'", CanonicalJSON(map[string]any{"proof": "Original durable input has its completed SDK receipt; unresolved usage remains unknown", "inputRequestId": receipt.InputRequestId}), operation.Id)
		CloseUserWaitForOperation(lifecycle.store, operation.Id)
		kernelExec(lifecycle.store.Db, "UPDATE nodes SET status='running' WHERE task_id=? AND id=? AND activation_id=?", operation.TaskId, operation.NodeId, operation.ActivationId)
		kernelExec(lifecycle.store.Db, "UPDATE activations SET state='running' WHERE id=?", operation.ActivationId)
		lifecycle.store.Event(operation.TaskId, "operation.durable_resumed", map[string]any{"operationId": operation.Id, "inputRequestId": receipt.InputRequestId})
		outcome := "completed"
		if receipt.StopReason == "error" || receipt.StopReason == "aborted" {
			outcome = "failed"
		}
		lifecycle.settle(operation, OperationResult{Outcome: outcome, Output: map[string]any{"text": receipt.FinalAssistantText}, Usage: &usage}, operationSettleOptions{})
		return nil
	})
}
