package graph

import (
	"strings"

	"encoding/json"
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
		// A rejected credential is renewed and the turn runs again. This sits before
		// the open-question guard on purpose: that guard exists so a retry cannot
		// race a decision already waiting for main, but a dead token is not a
		// decision - it is a one-minute fix, and an old question must not park a
		// turn the fresh token would finish.
		if l.recoverCredential(operation, result) {
			return
		}
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
				l.store.MarkOperationSettled(operation.Id, CanonicalJSON(result))
				l.store.RetryNodeOutput(operation.TaskId, operation.NodeId, CanonicalJSON(result.Output), operation.Id)
				l.store.RetryActivation(operation.ActivationId)
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
		l.store.RecordUnknownOperationResult(operation.Id, CanonicalJSON(result))
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
	l.store.MarkOperationSucceeded(operation.Id, CanonicalJSON(result), storedUsage, NowMillis())
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
	// The same usage that funds the instance also spends the conversation's
	// standing goal. A provider that refuses the turn for capacity reasons says
	// nothing about the objective, so the goal stops as recoverable instead of
	// counting as work: a 429 ends the run until the quota exists again.
	if conversation != nil {
		answer := ""
		if output, ok := result.Output.(map[string]any); ok {
			if text, ok := output["text"].(string); ok {
				answer = text
			}
		}
		goal := l.store.Goal(conversation.Id)
		switch {
		case result.Outcome == "failed" && IsCapacityFailure(describeFailure(result.Output)):
			MarkGoalUsageLimited(l.store, conversation.Id, NowMillis())
		case result.Outcome == "failed" && goal != nil && goal.Status == GoalVerifying:
			// The acceptance turn could not run (the provider failed, or the
			// turn produced nothing). That is not a pass: nothing completes and
			// nothing advances.
			FailGoalAcceptance(l.store, conversation.Id, describeFailure(result.Output), NowMillis())
		case usage != nil:
			AccountGoalUsage(l.store, conversation.Id, total, NowMillis())
			// A goal is the work: when a turn ends cleanly, the next turn starts
			// from the goal - or judges the completion claim it just made -
			// instead of waiting for a person.
			if result.Outcome == "completed" && total > 0 {
				SettleGoalTurn(l.store, conversation.Id, answer, NowMillis())
			}
		}
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
	case conversation != nil && result.Outcome == "completed" && len(PendingWakes(l.store, operation.TaskId, operation.NodeId)) > 0:
		nextStatus = "pending"
	case result.Outcome == "completed":
		nextStatus = "succeeded"
	case result.Outcome == "continue":
		nextStatus = "pending"
	default:
		nextStatus = result.Outcome
	}
	l.store.SettleNodeOutput(operation.TaskId, operation.NodeId, nextStatus, CanonicalJSON(result.Output), operation.Id)
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
	l.store.SettleActivation(operation.ActivationId, operation.TaskId, operation.NodeId)
}

// bindWakes binds ready wakes to the turn that is about to act on them.
func (l *OperationLifecycle) bindWakes(operation Operation) {
	if len(operation.Context.Wakes) == 0 {
		return
	}
	kinds := []string{}
	dedupeKeys := []string{}
	for _, wake := range operation.Context.Wakes {
		if ConsumeWake(l.store, operation.TaskId, operation.NodeId, operation.Id, wake.Kind, wake.DedupeKey) != 0 {
			kinds = append(kinds, wake.Kind)
			dedupeKeys = append(dedupeKeys, wake.DedupeKey)
		}
	}
	if len(kinds) == 0 {
		return
	}
	l.store.Event(operation.TaskId, "wake.delivered", map[string]any{
		"operationId": operation.Id,
		"kinds":       kinds,
		"dedupeKeys":  dedupeKeys,
	})
}

// recoverCredential hands a credential-rejected turn to the renewer, and settles it
// without a question.
//
// It reports whether the turn was handed over. The renewal cannot happen here: this
// runs under the dispatcher's database lock, and writing a secret goes through the
// configuration host, which takes the same lock, so waiting for the renewal inside
// this call deadlocks the dispatch cycle. The request carries everything the renewer
// needs to requeue the node once the credential is usable again.
func (l *OperationLifecycle) recoverCredential(operation Operation, result OperationResult) bool {
	if l.hooks.OnCredentialRejected == nil {
		return false
	}
	output := describeFailure(result.Output)
	if !credentialRejection(output) {
		return false
	}
	attempt := int64(0)
	if node := kernelRow(l.store.Db, "SELECT stall_count FROM nodes WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId); node != nil {
		attempt = kernelInt(node["stall_count"])
	}
	if int(attempt)+1 > MAX_TRANSIENT_RETRIES {
		return false
	}
	// The model that was actually picked lives on the instance: the node spec names
	// the definition's request (`main`), not the provider model the send used.
	model := kernelString(kernelRow(l.store.Db, "SELECT model FROM instances WHERE task_id=? AND node_id=?",
		operation.TaskId, operation.NodeId)["model"])
	if model == "" {
		model = kernelString(kernelRow(l.store.Db, "SELECT json_extract(spec,'$.model') AS model FROM nodes WHERE task_id=? AND id=?",
			operation.TaskId, operation.NodeId)["model"])
	}
	scheduled := l.hooks.OnCredentialRejected(CredentialRecoveryRequest{
		Model: model, TaskId: operation.TaskId, NodeId: operation.NodeId, OperationId: operation.Id,
		ActivationId: operation.ActivationId, Output: CanonicalJSON(result.Output),
	})
	if !scheduled {
		return false
	}
	// The operation is closed so the dispatch cycle can end; the node stays pending and
	// the renewal requeues it. A failed turn with a dead credential owes nobody a
	// question: the renewal files one only when the vendor refuses it.
	l.store.MarkOperationSettled(operation.Id, CanonicalJSON(result))
	l.store.RetryNodeOutput(operation.TaskId, operation.NodeId, CanonicalJSON(result.Output), operation.Id)
	l.store.Event(operation.TaskId, "node.credential_refresh_scheduled", map[string]any{
		"nodeId": operation.NodeId, "operationId": operation.Id, "model": model,
		"attempt": attempt + 1, "reason": "OAuth 凭据被拒，已安排刷新后重跑本轮",
	})
	return true
}
