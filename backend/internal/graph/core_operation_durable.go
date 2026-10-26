package graph

import (
	"fmt"
)

// durableCompletion is the kernel's receipt of a turn it finished.
//
// The kernel kept the answer the model gave, so the Graph can settle the
// operation from it instead of asking the model again.
type durableCompletion struct {
	ExecutionId               string   `json:"executionId"`
	Identity                  string   `json:"identity"`
	InputRequestId            string   `json:"inputRequestId"`
	PreAdmissionInvocationIds []string `json:"preAdmissionInvocationIds"`
	FinalAssistantText        string   `json:"finalAssistantText"`
	StopReason                string   `json:"stopReason"`
}

// acceptDurableCompletion settles an operation from the kernel's receipt.
//
// The receipt is the proof that the turn is still there: the model answered
// it, and the answer is what the operation settles with. The usage that is
// not known stays unknown.
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
		lifecycle.store.MarkOperationDispatched(operation.Id)
		lifecycle.store.ResolveOperationRecoveryQuestions(operation.Id, map[string]any{"proof": "Original durable input has its completed SDK receipt; unresolved usage remains unknown", "inputRequestId": receipt.InputRequestId})
		CloseUserWaitForOperation(lifecycle.store, operation.Id)
		lifecycle.store.SetNodeRunningForActivation(operation.TaskId, operation.NodeId, operation.ActivationId)
		lifecycle.store.RunActivation(operation.ActivationId)
		lifecycle.store.Event(operation.TaskId, "operation.durable_resumed", map[string]any{"operationId": operation.Id, "inputRequestId": receipt.InputRequestId})
		outcome := "completed"
		if receipt.StopReason == "error" || receipt.StopReason == "aborted" {
			outcome = "failed"
		}
		lifecycle.settle(operation, OperationResult{Outcome: outcome, Output: map[string]any{"text": receipt.FinalAssistantText}, Usage: &usage}, operationSettleOptions{})
		return nil
	})
}
