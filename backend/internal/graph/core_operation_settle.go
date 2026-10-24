package graph

import (
	"encoding/json"
	"strings"
)

type operationSettleOptions struct {
	Reconciled bool
}

func operationResultWithoutUsage(result OperationResult) string {
	copied := result
	copied.Usage = nil
	return CanonicalJSON(copied)
}

func (l *OperationLifecycle) settle(operation Operation, result OperationResult, options operationSettleOptions) {
	outcomes := []string{"completed", "continue", "waiting", "failed", "skipped"}
	if !containsString(outcomes, result.Outcome) {
		Raise("invalid_result", "Unexpected operation outcome")
	}
	CanonicalJSON(result)
	row := l.operationRow(operation.Id)
	if kernelString(row["state"]) == "succeeded" {
		if kernelString(row["result"]) != CanonicalJSON(result) {
			Raise("result_conflict", "Operation already has a different result")
		}
		return
	}
	state := kernelString(row["state"])
	if state != "dispatched" && state != "unknown" {
		Raise("invalid_operation", "Operation was not dispatched")
	}
	currentNode := kernelRow(l.store.Db, "SELECT activation_id FROM nodes WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
	if kernelString(currentNode["activation_id"]) != operation.ActivationId {
		Raise("stale_activation", "Operation belongs to a replaced activation")
	}
	ClearConversationStream(l.store, operation.Id)
	if row["result"] != nil {
		var previous OperationResult
		if err := json.Unmarshal([]byte(kernelString(row["result"])), &previous); err != nil {
			panic(err)
		}
		if operationResultWithoutUsage(previous) != operationResultWithoutUsage(result) {
			Raise("result_conflict", "Known result cannot change during usage reconciliation")
		}
	}
	var rawUsage *TokenUsage
	if operation.Kind == "agent" {
		rawUsage = result.Usage
	} else {
		authoritative := "authoritative"
		rawUsage = &TokenUsage{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0, UsageSource: &authoritative}
	}
	var normalizedUsage *TokenUsage
	if rawUsage != nil {
		value := NormalizeTokenUsage(*rawUsage)
		normalizedUsage = &value
	}
	source := UsageSourceOf(normalizedUsage)
	estimatedRequiresReconciliation := source == UsageEstimated && !options.Reconciled
	fullAccess := IsFullAccess(operation.AccessPolicy)
	if result.Outcome == "failed" {
		if kernelRow(l.store.Db, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'",
			operation.TaskId, operation.NodeId) == nil {
			attempt := int64(0)
			node := kernelRow(l.store.Db, "SELECT stall_count FROM nodes WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
			if node != nil {
				attempt = kernelInt(node["stall_count"])
			}
			decision := RetryDecision(struct {
				Output  string
				Attempt int
			}{Output: describeFailure(result.Output), Attempt: int(attempt) + 1})
			if decision.Retry {
				kernelExec(l.store.Db, "UPDATE operations SET state='settled',worker_active=0,result=? WHERE id=?",
					CanonicalJSON(result), operation.Id)
				kernelExec(l.store.Db, "UPDATE nodes SET status='pending',output=?,stall_count=stall_count+1,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?",
					CanonicalJSON(result.Output), operation.Id, operation.TaskId, operation.NodeId)
				kernelExec(l.store.Db, "UPDATE activations SET state='pending',round=round+1 WHERE id=?", operation.ActivationId)
				l.store.Event(operation.TaskId, "node.transient_retry", map[string]any{
					"nodeId":      operation.NodeId,
					"attempt":     decision.Attempt,
					"reason":      decision.Reason,
					"operationId": operation.Id,
				})
				return
			}
		}
	}
	missingUsage := !fullAccess && (normalizedUsage == nil ||
		(source == UsageUnknown && !options.Reconciled) ||
		(estimatedRequiresReconciliation && !UnknownUsageIsNonBlocking(l.store, operationInstanceId(operation))))
	unknownUsageAllowed := fullAccess || (missingUsage && UnknownUsageIsNonBlocking(l.store, operationInstanceId(operation)))
	if missingUsage && !unknownUsageAllowed {
		RecordConversationOutput(l.store, operation, result)
		kernelExec(l.store.Db, "UPDATE operations SET state='unknown',worker_active=0,result=? WHERE id=?", CanonicalJSON(result), operation.Id)
		l.store.SetNodeBlocked(operation.TaskId, operation.NodeId)
		l.store.ResolveOperationRecoveryQuestions(operation.Id, map[string]any{"result": result})
		CloseUserWaitForOperation(l.store, operation.Id)
		if kernelRow(l.store.Db, "SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'", operation.Id) == nil {
			reason := "Agent returned no accountable usage"
			if source == UsageEstimated {
				reason = "Agent returned only estimated usage for a finite budget"
			}
			InsertQuestion(l.store, QuestionInput{
				TaskId:      operation.TaskId,
				NodeId:      operation.NodeId,
				OperationId: operationLifecycleStringPtr(operation.Id),
				Kind:        "unknown_usage",
				Data:        map[string]any{"reason": reason, "usageSource": string(source)},
			})
			l.store.Event(operation.TaskId, "operation.unknown", map[string]any{"operationId": operation.Id, "reason": "unknown_usage", "usageSource": string(source)})
		}
		return
	}
	if fullAccess && (normalizedUsage == nil || source == UsageUnknown) {
		l.store.Event(operation.TaskId, "operation.usage_unknown", map[string]any{
			"operationId": operation.Id,
			"nodeId":      operation.NodeId,
			"policy":      "non_blocking_full_access",
			"usageSource": string(source),
		})
	}
	if missingUsage {
		policy := "non_blocking_unlimited"
		if fullAccess {
			policy = "non_blocking_full_access"
		}
		l.store.Event(operation.TaskId, "operation.usage_unknown", map[string]any{
			"operationId": operation.Id,
			"nodeId":      operation.NodeId,
			"policy":      policy,
			"usageSource": string(source),
		})
	}
	usage := normalizedUsage
	total := int64(0)
	if usage != nil {
		values := []int64{usage.Input, usage.Output, usage.CacheRead, usage.CacheWrite}
		for _, value := range values {
			if !jsSafeInteger(value) || value < 0 {
				Raise("invalid_usage", "Invalid disjoint token counts")
			}
			total += value
		}
		if !jsSafeInteger(total) {
			Raise("invalid_usage", "Invalid disjoint token counts")
		}
	}
	specRow := kernelRow(l.store.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
	var nodeSpec NodeSpec
	if err := json.Unmarshal([]byte(kernelString(specRow["spec"])), &nodeSpec); err != nil {
		panic(err)
	}
	validateOperationArtifacts(result.Artifacts)
	if result.Outcome == "skipped" {
		Raise("invalid_result", "Main execution cannot skip work")
	}
	var storedUsage any
	if usage != nil {
		storedUsage = CanonicalJSON(usage)
	}
	kernelExec(l.store.Db, `UPDATE operations
    SET state='succeeded',worker_active=0,result=?,usage=?,settled_at=COALESCE(settled_at,?)
    WHERE id=?`, CanonicalJSON(result), storedUsage, NowMillis(), operation.Id)
	l.bindWakes(operation)
	ReleaseOperationReservation(l.store, operation.Id)
	if operation.InstanceId != nil && usage != nil {
		CommitUsage(l.store, *operation.InstanceId, total)
		RecordCurrentModelUse(l.store, *operation.InstanceId)
	}
	l.store.ResolveOperationQuestions(operation.Id, map[string]any{"result": result})
	CloseUserWaitForOperation(l.store, operation.Id)
	autoApprovedPermission := result.Outcome == "waiting" && result.Question != nil && result.Question.Grant != nil &&
		operation.AccessPolicy != nil && operation.AccessPolicy.AutoApprove.Permission
	if result.Outcome == "waiting" {
		if result.Question == nil || strings.TrimSpace(result.Question.Prompt) == "" {
			Raise("invalid_result", "Waiting requires a question")
		}
		if result.Question.Grant != nil {
			l.Block(operation.TaskId, operation.NodeId, "permission", map[string]any{"grant": *result.Question.Grant}, operationLifecycleStringPtr(operation.Id))
		} else {
			data := result.Question.Data
			if data == nil {
				data = map[string]any{"prompt": result.Question.Prompt}
			}
			l.Block(operation.TaskId, operation.NodeId, "waiting", data, operationLifecycleStringPtr(operation.Id))
		}
	}
	conversation := ConversationForTask(l.store, operation.TaskId)
	if nodeSpec.Role == nil || *nodeSpec.Role != "master" || operation.Kind != "agent" {
		conversation = nil
	}
	RecordConversationOutput(l.store, operation, result)
	queuedAfter := 0
	if conversation != nil {
		queuedAfter = len(PendingMessages(l.store, conversation.Id, 1))
	}
	nextStatus := "pending"
	switch {
	case autoApprovedPermission:
		nextStatus = "pending"
	case conversation != nil && result.Outcome == "completed" && queuedAfter > 0:
		nextStatus = "pending"
	case result.Outcome == "completed":
		nextStatus = "succeeded"
	case result.Outcome == "continue":
		nextStatus = "pending"
	default:
		nextStatus = result.Outcome
	}
	kernelExec(l.store.Db, `UPDATE nodes
    SET status=?,output=?,route=NULL,output_version=output_version+1,output_operation=?
    WHERE task_id=? AND id=?`,
		nextStatus,
		CanonicalJSON(result.Output),
		operation.Id,
		operation.TaskId,
		operation.NodeId,
	)
	if result.Outcome == "failed" {
		attempt := int64(0)
		node := kernelRow(l.store.Db, "SELECT stall_count FROM nodes WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
		if node != nil {
			attempt = kernelInt(node["stall_count"])
		}
		decision := RetryDecision(struct {
			Output  string
			Attempt int
		}{Output: describeFailure(result.Output), Attempt: int(attempt) + 1})
		data := map[string]any{
			"output":       result.Output,
			"retryVerdict": decision.Reason,
		}
		if decision.Exhausted {
			data["transientRetriesExhausted"] = MAX_TRANSIENT_RETRIES
		}
		l.Block(operation.TaskId, operation.NodeId, "execution_failed", data, operationLifecycleStringPtr(operation.Id))
	}
	if !fullAccess && total > kernelInt(row["reserved"]) {
		l.Block(operation.TaskId, operation.NodeId, "reservation_exceeded", map[string]any{
			"reserved": kernelInt(row["reserved"]),
			"actual":   total,
		}, operationLifecycleStringPtr(operation.Id))
	}
	l.store.Event(operation.TaskId, "operation.result", map[string]any{"operationId": operation.Id, "result": result})
	kernelExec(l.store.Db, "UPDATE activations SET state=(SELECT status FROM nodes WHERE task_id=? AND id=?) WHERE id=?",
		operation.TaskId, operation.NodeId, operation.ActivationId)
}

// bindWakes binds ready wakes to the turn that is about to act on them.
func (l *OperationLifecycle) bindWakes(operation Operation) {
	ready := PendingWakes(l.store, operation.TaskId, operation.NodeId)
	if len(ready) == 0 {
		return
	}
	ConsumeWakes(l.store, operation.TaskId, operation.NodeId, operation.Id)
	kinds := []string{}
	dedupeKeys := []string{}
	for _, wake := range ready {
		kinds = append(kinds, string(wake.Kind))
		dedupeKeys = append(dedupeKeys, wake.DedupeKey)
	}
	l.store.Event(operation.TaskId, "wake.delivered", map[string]any{
		"operationId": operation.Id,
		"kinds":       kinds,
		"dedupeKeys":  dedupeKeys,
	})
}
