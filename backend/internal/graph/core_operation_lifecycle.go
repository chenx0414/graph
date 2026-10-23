package graph

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// OperationNode identifies the node an operation belongs to.
type OperationNode struct {
	Id           string
	TaskId       string
	ActivationId string
}

// OperationIntent is the operation without its identity: id, generation and attempt
// are assigned by the lifecycle when the intent becomes durable.
type OperationIntent struct {
	TaskId             string
	NodeId             string
	InstanceId         *string
	Kind               string
	Action             string
	Input              Json
	Dependencies       map[string]Json
	ProposalVersion    int
	RequirementVersion int
	Context            OperationContext
	Grants             []string
	AccessPolicy       *ResolvedAccessPolicy
	ActivationId       string
	GraphVersion       int
	DependencySources  map[string][]DependencySource
	InputVersions      map[string][]InputVersion
	Workspace          *string
}

// operation materializes the intent as the durable operation.
func (intent OperationIntent) operation(id string, generation, attempt int) Operation {
	dependencies := intent.Dependencies
	if dependencies == nil {
		dependencies = map[string]Json{}
	}
	dependencySources := intent.DependencySources
	if dependencySources == nil {
		dependencySources = map[string][]DependencySource{}
	}
	inputVersions := intent.InputVersions
	if inputVersions == nil {
		inputVersions = map[string][]InputVersion{}
	}
	grants := intent.Grants
	if grants == nil {
		grants = []string{}
	}
	return Operation{
		Id:                 id,
		TaskId:             intent.TaskId,
		NodeId:             intent.NodeId,
		InstanceId:         intent.InstanceId,
		Generation:         generation,
		Attempt:            attempt,
		Kind:               intent.Kind,
		Action:             intent.Action,
		Input:              intent.Input,
		Dependencies:       dependencies,
		ProposalVersion:    intent.ProposalVersion,
		RequirementVersion: intent.RequirementVersion,
		Context:            intent.Context,
		Grants:             grants,
		AccessPolicy:       intent.AccessPolicy,
		ActivationId:       intent.ActivationId,
		GraphVersion:       intent.GraphVersion,
		DependencySources:  dependencySources,
		InputVersions:      inputVersions,
		Workspace:          intent.Workspace,
	}
}

// OperationIntentEvent is what an `operation.intent` event carries: enough to identify
// the operation in a timeline, and nothing else.
func OperationIntentEvent(operation Operation) map[string]any {
	return map[string]any{
		"operationId":        operation.Id,
		"taskId":             operation.TaskId,
		"nodeId":             operation.NodeId,
		"instanceId":         operation.InstanceId,
		"generation":         operation.Generation,
		"attempt":            operation.Attempt,
		"kind":               operation.Kind,
		"action":             operation.Action,
		"proposalVersion":    operation.ProposalVersion,
		"requirementVersion": operation.RequirementVersion,
		"specRef":            "operations.spec",
	}
}

// OperationSnapshot is one operation row plus its parsed state.
type OperationSnapshot struct {
	Id           string           `json:"id"`
	Operation    Operation        `json:"operation"`
	State        string           `json:"state"`
	Reserved     int64            `json:"reserved"`
	WorkerActive bool             `json:"workerActive"`
	Result       *OperationResult `json:"result"`
	DispatchedAt *int64           `json:"dispatchedAt"`
	SettledAt    *int64           `json:"settledAt"`
}

// OperationRun is the per-node run projection.
type OperationRun struct {
	Id           string  `json:"id"`
	State        string  `json:"state"`
	ActivationId *string `json:"activationId"`
	WorkerActive bool    `json:"workerActive"`
	WaitingSlot  bool    `json:"waitingSlot"`
	Reserved     int64   `json:"reserved"`
	WaitingMs    int64   `json:"waitingMs"`
	RunMs        *int64  `json:"runMs"`
	DispatchedAt *int64  `json:"dispatchedAt"`
	SettledAt    *int64  `json:"settledAt"`
	Result       Json    `json:"result"`
	Usage        Json    `json:"usage"`
}

// OperationLifecycleHooks lets the host veto a replay before the adapter sent anything.
type OperationLifecycleHooks struct {
	CanReplayBeforeSend func(operation Operation) bool
}

// OperationAdmitInput is one admission of an operation.
type OperationAdmitInput struct {
	Node        OperationNode
	Reservation int64
	Prepare     func(attempt int) OperationIntent
	AfterIntent func(operation Operation)
}

// OperationQuery selects operation rows.
type OperationQuery struct {
	After  *string
	Before *string
	Latest bool
	NodeId *string
	Limit  *int
}

var operationDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// operationInstanceId is the instance of an operation, or the empty string.
func operationInstanceId(operation Operation) string {
	if operation.InstanceId == nil {
		return ""
	}
	return *operation.InstanceId
}

// operationLifecycleStringPtr is the optional-string helper of this file.
func operationLifecycleStringPtr(value string) *string {
	return &value
}

// operationLifecycleTokenTotal is the total of one disjoint token count.
func operationLifecycleTokenTotal(usage TokenUsage) int64 {
	return TokenUsageTotal(usage)
}

// operationFrom parses the stored operation spec.
func operationFrom(row map[string]any) Operation {
	var operation Operation
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &operation); err != nil {
		panic(err)
	}
	return operation
}

// describeFailure flattens the words a failed operation left behind, so the
// environment-failure predicate sees text instead of a shape.
func describeFailure(output Json) string {
	if output == nil {
		return ""
	}
	if text, ok := output.(string); ok {
		return text
	}
	record, ok := jsonRecord(output)
	if !ok {
		return jsonStringify(output)
	}
	parts := []string{}
	for _, key := range []string{"error", "stderr", "stdout", "message", "reason"} {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "\n")
	}
	return jsonStringify(output)
}

// sumKnownUsage adds the known usage rows and keeps the weakest provenance.
func sumKnownUsage(rows []map[string]any) TokenUsage {
	total := TokenUsage{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0}
	var source *UsageSource
	for _, row := range rows {
		text := kernelString(row["usage"])
		if text == "" {
			unknown := UsageUnknown
			if source == nil {
				source = &unknown
			} else {
				merged := MergeUsageSource(*source, UsageUnknown)
				source = &merged
			}
			continue
		}
		var usage TokenUsage
		if err := json.Unmarshal([]byte(text), &usage); err != nil {
			panic(err)
		}
		total.Input += usage.Input
		total.Output += usage.Output
		total.CacheRead += usage.CacheRead
		total.CacheWrite += usage.CacheWrite
		next := UsageSourceOf(&usage)
		if source == nil {
			value := next
			source = &value
		} else {
			value := MergeUsageSource(*source, next)
			source = &value
		}
	}
	if source == nil {
		unknown := string(UsageUnknown)
		total.UsageSource = &unknown
		return total
	}
	value := string(*source)
	total.UsageSource = &value
	return total
}

// OperationLifecycle owns the durable ordering around the adapter's work: intent,
// dispatch, reconciliation, settlement, blocking questions and rework.
type OperationLifecycle struct {
	generation int
	store      *TaskStore
	hooks      OperationLifecycleHooks
}

// NewOperationLifecycle binds the lifecycle to one task store.
func NewOperationLifecycle(store *TaskStore, hooks OperationLifecycleHooks) *OperationLifecycle {
	return &OperationLifecycle{store: store, hooks: hooks}
}

func (l *OperationLifecycle) transaction(action func() any) any {
	if l.store.IsTransaction() {
		return action()
	}
	return l.store.Transaction(action)
}

func (l *OperationLifecycle) operationRow(id string) map[string]any {
	row := kernelRow(l.store.Db, "SELECT * FROM operations WHERE id=?", id)
	if row == nil {
		Raise("not_found", "Operation not found")
	}
	return row
}

func (l *OperationLifecycle) nodeRow(taskId, nodeId string) map[string]any {
	row := kernelRow(l.store.Db, "SELECT * FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	if row == nil {
		Raise("not_found", "Unknown node "+nodeId)
	}
	return row
}

// Get reads one operation snapshot.
func (l *OperationLifecycle) Get(id string) *OperationSnapshot {
	row := kernelRow(l.store.Db, "SELECT * FROM operations WHERE id=?", id)
	if row == nil {
		return nil
	}
	return operationSnapshotOf(row)
}

func operationSnapshotOf(row map[string]any) *OperationSnapshot {
	snapshot := &OperationSnapshot{
		Id:           kernelString(row["id"]),
		Operation:    operationFrom(row),
		State:        kernelString(row["state"]),
		Reserved:     kernelInt(row["reserved"]),
		WorkerActive: kernelInt(row["worker_active"]) != 0,
	}
	if text := kernelString(row["result"]); text != "" {
		var result OperationResult
		if err := json.Unmarshal([]byte(text), &result); err != nil {
			panic(err)
		}
		snapshot.Result = &result
	}
	if row["dispatched_at"] != nil {
		value := kernelInt(row["dispatched_at"])
		snapshot.DispatchedAt = &value
	}
	if row["settled_at"] != nil {
		value := kernelInt(row["settled_at"])
		snapshot.SettledAt = &value
	}
	return snapshot
}

// Recover enters a new runtime generation and conservatively recovers prior work.
func (l *OperationLifecycle) Recover() int {
	return l.transaction(func() any {
		kernelExec(l.store.Db, "UPDATE runtime SET generation=generation+1")
		row := kernelRow(l.store.Db, "SELECT generation FROM runtime")
		generation := int(kernelInt(row["generation"]))
		l.generation = generation
		rows := kernelRows(l.store.Db, "SELECT * FROM operations WHERE state IN ('intent','dispatched')")
		for _, row := range rows {
			if kernelString(row["state"]) == "intent" {
				l.markNotSent(row, operationNotSentOptions{ResetNode: true, EventReason: operationLifecycleStringPtr("Recovered before dispatch")})
				ReleaseMessages(l.store, kernelString(row["id"]))
				continue
			}
			if l.restoreUnsentConversation(row) {
				continue
			}
			// Access grants cannot prove that an interrupted effect never happened.

			kernelExec(l.store.Db, "UPDATE operations SET state='unknown',worker_active=0,waiting_slot=0 WHERE id=?", kernelString(row["id"]))
			l.store.Event(kernelString(row["task_id"]), "operation.unknown", map[string]any{
				"operationId": kernelString(row["id"]),
				"reason":      "Recovered after restart with no live worker",
				"quiescent":   true,
			})
			l.Block(kernelString(row["task_id"]), kernelString(row["node_id"]), "recovery", map[string]any{
				"reason": "Dispatch was recorded; external outcome and worker liveness require reconciliation",
			}, operationLifecycleStringPtr(kernelString(row["id"])))
		}
		stranded := kernelRows(l.store.Db, `WITH candidates AS MATERIALIZED (
        SELECT DISTINCT o.* FROM operations o
        JOIN messages m ON m.operation_id=o.id AND m.role='user' AND m.state='delivered'
        JOIN tasks t ON t.id=o.task_id
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        WHERE o.state='not_sent' AND t.phase='chatting' AND n.status IN ('pending','failed')
          AND o.activation_id=n.activation_id)
        SELECT o.* FROM candidates o WHERE NOT EXISTS (SELECT 1 FROM operations later WHERE later.task_id=o.task_id AND later.node_id=o.node_id
            AND later.rowid>(SELECT rowid FROM operations WHERE id=o.id) AND (later.state!='not_sent' OR later.result IS NOT NULL))
          AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=o.task_id AND e.type='operation.recovery_bypassed'
            AND json_extract(e.data,'$.operationId')=o.id)`)
		for _, row := range stranded {
			l.restoreUnsentConversation(row)
		}
		kernelExec(l.store.Db, "UPDATE operations SET worker_active=0 WHERE state='unknown' AND worker_active=1")
		return generation
	}).(int)
}

func (l *OperationLifecycle) restoreUnsentConversation(row map[string]any) bool {
	taskId := kernelString(row["task_id"])
	task := l.store.Task(taskId)
	if task.Phase != "chatting" || task.Paused != 0 || row["result"] != nil {
		return false
	}
	node := l.nodeRow(taskId, kernelString(row["node_id"]))
	var spec NodeSpec
	if err := json.Unmarshal([]byte(kernelString(node["spec"])), &spec); err != nil {
		panic(err)
	}
	if spec.Role == nil || *spec.Role != "master" {
		return false
	}
	activationId := kernelString(node["activation_id"])
	if row["activation_id"] == nil || kernelString(row["activation_id"]) != activationId {
		return false
	}
	conversation := ConversationForTask(l.store, taskId)
	if conversation == nil || conversation.ArchivedAt != nil {
		return false
	}
	if kernelRow(l.store.Db, "SELECT 1 FROM questions WHERE task_id=? AND node_id=? AND status='open' LIMIT 1", taskId, kernelString(row["node_id"])) != nil {
		return false
	}
	if kernelRow(l.store.Db, "SELECT 1 FROM messages WHERE operation_id=? AND role='user' AND state='delivered' LIMIT 1", kernelString(row["id"])) == nil {
		return false
	}
	if l.hooks.CanReplayBeforeSend == nil || !l.hooks.CanReplayBeforeSend(operationFrom(row)) {
		return false
	}
	if kernelString(row["state"]) == "not_sent" {
		later := kernelRows(l.store.Db, `SELECT spec FROM operations WHERE task_id=? AND node_id=?
        AND rowid>(SELECT rowid FROM operations WHERE id=?) ORDER BY rowid`, taskId, kernelString(row["node_id"]), kernelString(row["id"]))
		for _, next := range later {
			var operation Operation
			if err := json.Unmarshal([]byte(kernelString(next["spec"])), &operation); err != nil {
				panic(err)
			}
			if l.hooks.CanReplayBeforeSend == nil || !l.hooks.CanReplayBeforeSend(operation) {
				return false
			}
		}
	}
	l.markNotSent(row, operationNotSentOptions{ResetNode: true, EventReason: operationLifecycleStringPtr("Recovered conversation before adapter session/send")})
	ReleaseMessages(l.store, kernelString(row["id"]))
	kernelExec(l.store.Db, "UPDATE activations SET state='pending' WHERE id=?", activationId)
	l.store.Event(taskId, "conversation.turn_requeued", map[string]any{"operationId": kernelString(row["id"]), "reason": "adapter_not_started"})
	return true
}

// Admit creates the durable intent before any adapter can cause an external effect.
func (l *OperationLifecycle) Admit(input OperationAdmitInput) Operation {
	return l.transaction(func() any {
		if input.Reservation < 0 {
			Raise("invalid_adapter", "A bounded token reservation is required")
		}
		row := kernelRow(l.store.Db, "SELECT COUNT(*) AS count FROM operations WHERE task_id=? AND node_id=?", input.Node.TaskId, input.Node.Id)
		attempt := int(kernelInt(row["count"])) + 1
		operation := input.Prepare(attempt).operation(graphUUID(), l.generation, attempt)
		kernelExec(l.store.Db, `INSERT INTO operations(
        id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id
      ) VALUES(?,?,?,?,?,?,'intent',?,?)`,
			operation.Id,
			operation.TaskId,
			operation.NodeId,
			operation.InstanceId,
			operation.Generation,
			CanonicalJSON(operation),
			0,
			operation.ActivationId,
		)
		ReserveOperation(l.store, operation.Id, input.Reservation)
		if input.AfterIntent != nil {
			input.AfterIntent(operation)
		}
		kernelExec(l.store.Db, "UPDATE activations SET input_versions=?,state='preparing' WHERE id=?",
			CanonicalJSON(operation.InputVersions), operation.ActivationId)
		kernelExec(l.store.Db, "UPDATE nodes SET status='preparing' WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
		l.store.Event(operation.TaskId, "operation.intent", OperationIntentEvent(operation))
		return operation
	}).(Operation)
}

type operationNotSentOptions struct {
	ResetNode   bool
	EventReason *string
}

func (l *OperationLifecycle) markNotSent(row map[string]any, options operationNotSentOptions) {
	now := NowMillis()
	id := kernelString(row["id"])
	ClearConversationStream(l.store, id)
	kernelExec(l.store.Db, `UPDATE operations
      SET state='not_sent',worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?)
      WHERE id=?`, now, id)
	ReleaseOperationReservation(l.store, id)
	ReleaseRsiContinuation(l.store, id)
	ReleaseWakes(l.store, id)
	if options.ResetNode {
		kernelExec(l.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=?", kernelString(row["task_id"]), kernelString(row["node_id"]))
	}
	if options.EventReason != nil {
		l.store.Event(kernelString(row["task_id"]), "operation.not_sent", map[string]any{"operationId": id, "reason": *options.EventReason})
	}
}

// CancelBeforeDispatch rolls back a pre-dispatch attempt while preserving the node identity.
func (l *OperationLifecycle) CancelBeforeDispatch(operationId, reason string) {
	if reason == "" {
		reason = "Cancelled before dispatch"
	}
	l.transaction(func() any {
		row := l.operationRow(operationId)
		l.markNotSent(row, operationNotSentOptions{ResetNode: true, EventReason: operationLifecycleStringPtr(reason)})
		ReleaseMessages(l.store, operationId)
		return nil
	})
}

// MarkPreparationFailed records an adapter that could not even prepare.
func (l *OperationLifecycle) MarkPreparationFailed(operationId, reason string) {
	l.transaction(func() any {
		row := l.operationRow(operationId)
		l.markNotSent(row, operationNotSentOptions{ResetNode: false})
		ReleaseMessages(l.store, operationId)
		l.Block(kernelString(row["task_id"]), kernelString(row["node_id"]), "adapter_error", map[string]any{"reason": reason}, operationLifecycleStringPtr(operationId))
		RecordConversationInterruption(l.store, operationFrom(row), reason, "setup")
		return nil
	})
}

// Dispatch commits the dispatch boundary immediately before the adapter may send.
func (l *OperationLifecycle) Dispatch(operation Operation) {
	l.transaction(func() any {
		now := NowMillis()
		kernelExec(l.store.Db, "UPDATE operations SET state='dispatched',worker_active=1,dispatched_at=COALESCE(dispatched_at,?) WHERE id=?", now, operation.Id)
		kernelExec(l.store.Db, "UPDATE nodes SET status='running' WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
		kernelExec(l.store.Db, "UPDATE activations SET state='running' WHERE id=?", operation.ActivationId)
		l.store.Event(operation.TaskId, "operation.dispatched", map[string]any{"operationId": operation.Id})
		if operation.Context.RsiContinuation != nil {
			l.store.Event(operation.TaskId, "rsi.continuation_dispatched", map[string]any{
				"requestId":   operation.Context.RsiContinuation.RequestId,
				"operationId": operation.Id,
			})
		}
		return nil
	})
}

// Report settles one operation with the result the worker produced.
func (l *OperationLifecycle) Report(id string, generation int, result OperationResult) string {
	return l.transaction(func() any {
		row := l.operationRow(id)
		if int(kernelInt(row["generation"])) != generation || generation != l.generation {
			Raise("stale_generation", "Worker generation is stale")
		}
		operation := operationFrom(row)
		l.settle(operation, result, operationSettleOptions{})
		return operation.TaskId
	}).(string)
}

// Steer hands a running turn an operator message.
func (l *OperationLifecycle) Steer(operationId string, steer func(operation Operation) *int64) *int64 {
	row := l.operationRow(operationId)
	if kernelString(row["state"]) != "dispatched" || kernelInt(row["worker_active"]) == 0 {
		Raise("no_active_operation", "The master Agent is no longer accepting steering messages")
	}
	return steer(operationFrom(row))
}

// Interrupt stops a running turn.
func (l *OperationLifecycle) Interrupt(operationId string, interrupt func(operation Operation) *int64) *int64 {
	row := l.operationRow(operationId)
	if kernelString(row["state"]) != "dispatched" || kernelInt(row["worker_active"]) == 0 {
		Raise("no_active_operation", "The master Agent is no longer accepting interruption")
	}
	return interrupt(operationFrom(row))
}

// Reconcile applies a verified transition to an unknown external outcome.
func (l *OperationLifecycle) Reconcile(id string, reconcile func(operation Operation) Reconciliation, integrate func(operation Operation)) string {
	row := l.operationRow(id)
	if kernelString(row["state"]) != "unknown" {
		return kernelString(row["task_id"])
	}
	operation := operationFrom(row)
	evidence := reconcile(operation)
	if strings.TrimSpace(evidence.Proof) == "" {
		Raise("invalid_reconciliation", "Reconciliation requires evidence")
	}
	if evidence.State == "completed" && integrate != nil && operation.Kind == "agent" &&
		evidence.Result != nil && evidence.Result.Outcome == "completed" {
		integrate(operation)
	}
	l.transaction(func() any {
		current := kernelRow(l.store.Db, "SELECT state,result FROM operations WHERE id=?", id)
		if kernelString(current["state"]) != "unknown" {
			return nil
		}
		if evidence.State == "completed" {
			if !evidence.Quiescent {
				Raise("invalid_reconciliation", "Completion must prove the worker is quiescent")
			}
			if evidence.Result == nil {
				Raise("invalid_reconciliation", "Completion requires a result")
			}
			l.settle(operation, *evidence.Result, operationSettleOptions{})
		} else if evidence.State == "not_started" {
			if !evidence.Quiescent || current["result"] != nil {
				Raise("invalid_reconciliation", "Cannot retry an operation with a known result or a live worker")
			}
			l.markNotSent(l.operationRow(id), operationNotSentOptions{ResetNode: true})
			l.store.ResolveOperationQuestions(id, evidence)
			CloseUserWaitForOperation(l.store, id)
		} else {
			active := 0
			if !evidence.Quiescent {
				active = 1
			}
			kernelExec(l.store.Db, "UPDATE operations SET worker_active=? WHERE id=?", active, id)
		}
		l.store.Event(operation.TaskId, "operation.reconciled", map[string]any{"operationId": id, "evidence": evidence})
		return nil
	})
	return operation.TaskId
}

// HandleDispatchRefusal handles a refusal raised at the send boundary.
func (l *OperationLifecycle) HandleDispatchRefusal(operation Operation, refusal *RuntimeError, reservation int64) bool {
	refusalCodes := []string{"paused", "budget", "unknown_usage", "context_rejected", "interrupted"}
	if !containsString(refusalCodes, refusal.Code) {
		return false
	}
	if IsFullAccess(operation.AccessPolicy) && refusal.Code != "interrupted" {
		return l.transaction(func() any {
			row := l.operationRow(operation.Id)
			state := kernelString(row["state"])
			if state != "dispatched" && state != "unknown" {
				return false
			}
			l.markNotSent(row, operationNotSentOptions{
				ResetNode:   true,
				EventReason: operationLifecycleStringPtr("Full access bypassed " + refusal.Code + ": " + refusal.Message),
			})
			ReleaseMessages(l.store, operation.Id)
			return true
		}).(bool)
	}
	return l.transaction(func() any {
		row := l.operationRow(operation.Id)
		state := kernelString(row["state"])
		if state != "dispatched" && state != "unknown" {
			return false
		}
		invocations := kernelRows(l.store.Db, "SELECT usage FROM invocations WHERE operation_id=?", operation.Id)
		unknown := false
		total := int64(0)
		for _, item := range invocations {
			text := kernelString(item["usage"])
			if text == "" {
				unknown = true
				continue
			}
			var usage TokenUsage
			if err := json.Unmarshal([]byte(text), &usage); err != nil {
				panic(err)
			}
			source := UsageSourceOf(&usage)
			if source == UsageUnknown || (source == UsageEstimated && !UnknownUsageIsNonBlocking(l.store, operationInstanceId(operation))) {
				unknown = true
			}
			total += operationLifecycleTokenTotal(usage)
		}
		settledState := "not_sent"
		if len(invocations) > 0 {
			settledState = "interrupted"
		}
		ClearConversationStream(l.store, operation.Id)
		kernelExec(l.store.Db, `UPDATE operations
        SET state=?,worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?)
        WHERE id=?`, settledState, NowMillis(), operation.Id)
		ReleaseOperationReservation(l.store, operation.Id)
		if settledState == "interrupted" {
			if !unknown && total > 0 && operation.InstanceId != nil {
				CommitUsage(l.store, *operation.InstanceId, total)
				RecordCurrentModelUse(l.store, *operation.InstanceId)
			}
			l.store.Event(operation.TaskId, "operation.interrupted", map[string]any{
				"operationId": operation.Id,
				"reason":      refusal.Message,
				"usage":       usageForEvent(unknown, total),
				"invocations": len(invocations),
			})
		} else {
			ReleaseMessages(l.store, operation.Id)
			l.store.Event(operation.TaskId, "operation.not_sent", map[string]any{
				"operationId": operation.Id,
				"reason":      refusal.Message,
			})
		}
		switch refusal.Code {
		case "budget":
			l.Block(operation.TaskId, operation.NodeId, "budget", map[string]any{"reason": refusal.Message, "requested": reservation}, operationLifecycleStringPtr(operation.Id))
		case "context_rejected":
			data := map[string]any{
				"reason":        refusal.Message,
				"code":          refusal.Code,
				"requiredFacts": []any{},
				"policy":        "none",
			}
			l.store.Event(operation.TaskId, "context.rejected", map[string]any{"nodeId": operation.NodeId, "operationId": operation.Id, "data": data})
			l.Block(operation.TaskId, operation.NodeId, "context_rejected", data, operationLifecycleStringPtr(operation.Id))
		case "interrupted":
			kernelExec(l.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
			RecordConversationInterruption(l.store, operation, refusal.Message)
		default:
			if unknown || refusal.Code == "unknown_usage" {
				existing := kernelRow(l.store.Db, "SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'", operation.Id)
				if existing != nil {
					kernelExec(l.store.Db, "UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
				} else {
					l.Block(operation.TaskId, operation.NodeId, "unknown_usage", map[string]any{"reason": refusal.Message}, nil)
				}
			} else {
				kernelExec(l.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
			}
		}
		return true
	}).(bool)
}

func usageForEvent(unknown bool, total int64) any {
	if unknown {
		return nil
	}
	return total
}

// MarkUncertain records a post-dispatch error whose external outcome cannot be proven.
func (l *OperationLifecycle) MarkUncertain(operation Operation, reason string, quiescent bool) bool {
	return l.transaction(func() any {
		current := kernelRow(l.store.Db, "SELECT state FROM operations WHERE id=?", operation.Id)
		state := kernelString(current["state"])
		if state != "dispatched" && state != "unknown" {
			l.store.Event(operation.TaskId, "operation.report_rejected", map[string]any{
				"operationId": operation.Id,
				"reason":      reason,
			})
			return false
		}
		active := 0
		if !quiescent {
			active = 1
		}
		kernelExec(l.store.Db, "UPDATE operations SET state='unknown',worker_active=? WHERE id=?", active, operation.Id)
		l.store.Event(operation.TaskId, "operation.unknown", map[string]any{
			"operationId": operation.Id,
			"reason":      reason,
			"quiescent":   quiescent,
		})
		l.Block(operation.TaskId, operation.NodeId, "recovery", map[string]any{"reason": reason}, operationLifecycleStringPtr(operation.Id))
		RecordConversationInterruption(l.store, operation, reason)
		return true
	}).(bool)
}

// Block parks a node behind a question.
func (l *OperationLifecycle) Block(taskId, nodeId, kind string, data Json, operationId *string) string {
	return l.transaction(func() any {
		node := l.nodeRow(taskId, nodeId)
		kernelExec(l.store.Db, "UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?", taskId, nodeId)
		kernelExec(l.store.Db, "UPDATE activations SET state='blocked' WHERE id=?", kernelString(node["activation_id"]))
		var autoAnswer *QuestionAutoAnswer
		if operationId != nil && kind == "permission" {
			operation := l.Get(*operationId)
			grant := ""
			if record, ok := jsonRecord(data); ok {
				if value, ok := record["grant"].(string); ok {
					grant = value
				}
			}
			if operation != nil && operation.Operation.AccessPolicy != nil &&
				operation.Operation.AccessPolicy.AutoApprove.Permission && grant != "" {
				autoAnswer = &QuestionAutoAnswer{
					Answer:       Answer{Type: "grant", Grant: grant},
					PolicyDigest: operation.Operation.AccessPolicy.Digest,
					Resume:       boolPtr(true),
				}
			}
		}
		input := QuestionInput{TaskId: taskId, NodeId: nodeId, Kind: kind, Data: data}
		if operationId != nil {
			input.OperationId = operationId
		}
		if autoAnswer != nil {
			input.AutoAnswer = autoAnswer
		}
		question := InsertQuestion(l.store, input)
		return question.Id
	}).(string)
}

// Answer resolves a human answer and changes the formal state it implies.
func (l *OperationLifecycle) Answer(taskId, questionId string, answer Answer, models func() []ModelEntry) {
	l.transaction(func() any {
		question := kernelRow(l.store.Db, "SELECT * FROM questions WHERE id=? AND task_id=?", questionId, taskId)
		if question == nil || kernelString(question["status"]) != "open" {
			Raise("invalid_question", "No open question in this task")
		}
		kind := kernelString(question["kind"])
		nodeId := kernelString(question["node_id"])
		AssertQuestionAnswer(kind, answer)
		if kind == "budget" && answer.Type == "add_budget" {
			if answer.Tokens <= 0 {
				Raise("invalid_answer", "A positive token increment is required")
			}
			kernel := NewKernelStore(l.store)
			if kernel.LatestRevision(taskId) != nil {
				var data map[string]any
				if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
					panic(err)
				}
				executionId := ""
				if value, ok := data["executionId"].(string); ok {
					executionId = value
				}
				execution := kernel.Execution(executionId)
				if execution == nil || execution.TaskId != taskId || execution.NodeId != nodeId || execution.TokenBudget == nil {
					Raise("invalid_answer", "Budget question has no frozen execution quota")
				}
				quota := kernel.AuthorizedBudget(taskId, nodeId)
				budget := execution.TokenBudget.Budget
				if quota != nil {
					budget = quota.Budget
				}
				unlimited := execution.TokenBudget.Unlimited
				if quota != nil {
					unlimited = quota.Unlimited
				}
				if unlimited || !jsSafeInteger(int64(budget)+answer.Tokens) {
					Raise("invalid_answer", "Budget increment requires a finite quota within the safe integer range")
				}
				total := int64(budget) + answer.Tokens
				kernel.SetAuthorizedBudget(taskId, nodeId, &total)
				l.store.Event(taskId, "instance.budget_changed", map[string]any{"nodeId": nodeId, "tokens": total, "nextExecution": true})
			} else {
				instance := kernelRow(l.store.Db, "SELECT id FROM instances WHERE task_id=? AND node_id=?", taskId, nodeId)
				if instance == nil {
					Raise("not_found", "Unknown agent node")
				}
				AddBudget(l.store, kernelString(instance["id"]), answer.Tokens)
			}
		} else if kind == "unknown_usage" && (answer.Type == "usage" || answer.Type == "reconcile_usage") {
			operationId := kernelString(question["operation_id"])
			l.answerUnknownUsage(operationId, answer, models)
		} else if kind == "permission" && answer.Type == "grant" {
			var data map[string]any
			if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
				panic(err)
			}
			grant, _ := data["grant"].(string)
			if answer.Grant != grant {
				Raise("invalid_answer", "Grant must match the requested capability")
			}
			kernelExec(l.store.Db, "INSERT OR IGNORE INTO task_grants VALUES(?,?)", taskId, answer.Grant)
		} else if kind == "system_change" && answer.Type == "respond" {
			decision := ""
			if record, ok := jsonRecord(answer.Value); ok {
				if value, ok := record["decision"].(string); ok {
					decision = value
				}
			}
			if decision != "approved" && decision != "rejected" {
				Raise("invalid_answer", "A system change must be approved or rejected")
			}
		} else if kind == "human_check" && answer.Type == "reject" {
			var data map[string]any
			if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
				panic(err)
			}
			rejected := any(nil)
			if value, ok := data["prompt"]; ok {
				rejected = value
			}
			InsertQuestion(l.store, QuestionInput{
				TaskId: taskId,
				NodeId: nodeId,
				Kind:   "rework",
				Data: map[string]any{
					"prompt":   "A human acceptance check was rejected and must be reworked",
					"reason":   answer.Reason,
					"rejected": rejected,
				},
			})
			l.store.Event(taskId, "human.rejected", map[string]any{"questionId": questionId, "nodeId": nodeId, "reason": answer.Reason})
		}
		if kind == "human_check" && answer.Type == "acknowledge" {
			l.store.Event(taskId, "human.accepted", map[string]any{"questionId": questionId, "nodeId": nodeId})
		}
		l.store.ResolveQuestion(questionId, answer)
		CloseUserWait(l.store, taskId, nodeId)
		WakeForAnswer(l.store, taskId, map[string]any{
			"questionId": questionId,
			"nodeId":     nodeId,
			"kind":       kind,
			"answer":     answer,
		})
		if kernelRow(l.store.Db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_revisions'") != nil &&
			kernelRow(l.store.Db, "SELECT 1 FROM kernel_revisions WHERE task_id=? LIMIT 1", taskId) != nil {
			open := kernelRow(l.store.Db, "SELECT 1 FROM questions WHERE task_id=? AND status='open' LIMIT 1", taskId)
			if open == nil {
				l.store.CompleteBlockedTask(taskId)
			}
			return nil
		}
		if kernelRow(l.store.Db, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'", taskId, nodeId) == nil {
			current := kernelRow(l.store.Db, `SELECT o.state,o.result
          FROM operations o JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
          WHERE o.task_id=? AND o.node_id=? AND o.activation_id=n.activation_id
          ORDER BY o.rowid DESC LIMIT 1`, taskId, nodeId)
			completed := false
			if kernelString(current["state"]) == "succeeded" && current["result"] != nil {
				var result OperationResult
				if err := json.Unmarshal([]byte(kernelString(current["result"])), &result); err != nil {
					panic(err)
				}
				completed = result.Outcome == "completed"
			}
			specRow := kernelRow(l.store.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
			var spec NodeSpec
			if err := json.Unmarshal([]byte(kernelString(specRow["spec"])), &spec); err != nil {
				panic(err)
			}
			conversation := ConversationForTask(l.store, taskId)
			if spec.Role == nil || *spec.Role != "master" {
				conversation = nil
			}
			queued := 0
			if conversation != nil {
				queued = len(PendingMessages(l.store, conversation.Id, 1))
			}
			rejected := kind == "human_check" && answer.Type == "reject"
			next := "pending"
			if rejected {
				next = "blocked"
			} else if kind != "system_change" && completed && queued == 0 {
				next = "succeeded"
			}
			kernelExec(l.store.Db, "UPDATE nodes SET status=? WHERE task_id=? AND id=?", next, taskId, nodeId)
		}
		return nil
	})
}

// Escalate hands a main-owned problem to the user with the main Agent's explanation.
func (l *OperationLifecycle) Escalate(taskId, questionId, prompt string) {
	l.transaction(func() any {
		row := kernelRow(l.store.Db, `SELECT node_id,kind,data FROM questions
        WHERE id=? AND task_id=? AND status='open'`, questionId, taskId)
		if row == nil {
			Raise("invalid_question", "No open question in this task")
		}
		var source Json
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &source); err != nil {
			panic(err)
		}
		l.store.ResolveQuestion(questionId, map[string]any{"type": "escalated", "prompt": prompt})
		defects := []any{}
		if record, ok := jsonRecord(source); ok {
			if value, ok := record["defects"]; ok {
				if list, ok := value.([]any); ok {
					defects = list
				}
			}
		}
		escalated := InsertQuestion(l.store, QuestionInput{
			TaskId: taskId,
			NodeId: kernelString(row["node_id"]),
			Kind:   "waiting",
			Data: map[string]any{
				"requestType":   "noncompliance_decision",
				"prompt":        prompt,
				"escalatedFrom": kernelString(row["kind"]),
				"defects":       defects,
			},
		})
		l.store.Event(taskId, "problem.escalated", map[string]any{
			"questionId":  questionId,
			"nodeId":      kernelString(row["node_id"]),
			"kind":        kernelString(row["kind"]),
			"escalatedTo": escalated.Id,
		})
		return nil
	})
}

func (l *OperationLifecycle) answerUnknownUsage(operationId string, answer Answer, models func() []ModelEntry) {
	row := l.operationRow(operationId)
	if kernelString(row["state"]) == "interrupted" {
		l.recordInterruptedUsage(row, answer, models)
		return
	}
	if strings.TrimSpace(answer.Proof) == "" || row["result"] == nil || kernelInt(row["worker_active"]) != 0 {
		Raise("invalid_answer", "Usage requires a known result, quiescent worker and evidence")
	}
	operation := operationFrom(row)
	var result OperationResult
	if err := json.Unmarshal([]byte(kernelString(row["result"])), &result); err != nil {
		panic(err)
	}
	if answer.Type == "usage" {
		if answer.Usage == nil {
			Raise("invalid_answer", "Usage requires a known result, quiescent worker and evidence")
		}
		settled := result
		usage := NormalizeTokenUsage(*answer.Usage)
		settled.Usage = &usage
		l.settle(operation, settled, operationSettleOptions{})
		return
	}
	knownRows := kernelRows(l.store.Db, "SELECT usage FROM invocations WHERE operation_id=? AND usage IS NOT NULL", operationId)
	known := sumKnownUsage(knownRows)
	settled := result
	settled.Usage = &known
	l.settle(operation, settled, operationSettleOptions{Reconciled: true})
	l.store.Event(operation.TaskId, "operation.usage_reconciled", map[string]any{
		"operationId": operationId,
		"decision":    "usage_unavailable",
		"known":       known,
		"proof":       answer.Proof,
	})
}

func (l *OperationLifecycle) recordInterruptedUsage(row map[string]any, answer Answer, models func() []ModelEntry) {
	if strings.TrimSpace(answer.Proof) == "" {
		Raise("invalid_answer", "Evidence is required to release unknown usage")
	}
	if row["result"] != nil || kernelInt(row["worker_active"]) != 0 {
		Raise("invalid_answer", "Interrupted usage reconciliation requires a quiescent operation without a result")
	}
	if answer.Type == "usage" {
		if answer.Usage == nil {
			Raise("invalid_answer", "Evidence is required to release unknown usage")
		}
		unknown := kernelRows(l.store.Db, "SELECT id FROM invocations WHERE operation_id=? AND usage IS NULL", kernelString(row["id"]))
		if len(unknown) != 1 {
			Raise("invalid_answer", "Recording authoritative usage requires exactly one unknown invocation")
		}
		values := []int64{answer.Usage.Input, answer.Usage.Output, answer.Usage.CacheRead, answer.Usage.CacheWrite}
		total := int64(0)
		for _, value := range values {
			if !jsSafeInteger(value) || value < 0 {
				Raise("invalid_usage", "Invalid disjoint token counts")
			}
			total += value
		}
		if !jsSafeInteger(total) {
			Raise("invalid_usage", "Invalid disjoint token counts")
		}
		instanceId := kernelString(row["instance_id"])
		model := ""
		if instanceId != "" {
			instance := kernelRow(l.store.Db, "SELECT model FROM instances WHERE id=?", instanceId)
			if instance != nil {
				model = kernelString(instance["model"])
			}
		}
		var entry *ModelEntry
		if model != "" && models != nil {
			for index := range models() {
				if models()[index].Id == model {
					entry = &models()[index]
					break
				}
			}
		}
		usage := NormalizeTokenUsage(*answer.Usage)
		var cost *ModelCost
		var pricing *ModelPricing
		if entry != nil {
			cost = entry.Cost
			pricing = entry.Pricing
		}
		l.store.RecordInvocationUsage(kernelString(unknown[0]["id"]), CanonicalJSON(usage), CanonicalJSON(EstimateCost(usage, cost, pricing)))
	}
	knownRows := kernelRows(l.store.Db, "SELECT usage FROM invocations WHERE operation_id=? AND usage IS NOT NULL", kernelString(row["id"]))
	known := sumKnownUsage(knownRows)
	total := operationLifecycleTokenTotal(known)
	if total > 0 && kernelString(row["instance_id"]) != "" {
		CommitUsage(l.store, kernelString(row["instance_id"]), total)
		RecordCurrentModelUse(l.store, kernelString(row["instance_id"]))
	}
	decision := "usage_unavailable"
	if answer.Type == "usage" {
		decision = "recorded"
	}
	l.store.Event(kernelString(row["task_id"]), "operation.usage_reconciled", map[string]any{
		"operationId": kernelString(row["id"]),
		"decision":    decision,
		"known":       known,
		"proof":       answer.Proof,
	})
}

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
		kernelExec(l.store.Db, "UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
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

// validateOperationArtifacts refuses evidence the harness cannot use.
func validateOperationArtifacts(artifacts []ArtifactInput) {
	seen := map[string]bool{}
	for _, artifact := range artifacts {
		seen[artifact.Id] = true
	}
	if len(seen) != len(artifacts) {
		Raise("invalid_evidence", "Artifacts require unique IDs, absolute paths and SHA-256 digests")
	}
	for _, artifact := range artifacts {
		if strings.TrimSpace(artifact.Id) == "" || !filepath.IsAbs(artifact.Path) || !operationDigestPattern.MatchString(artifact.Digest) {
			Raise("invalid_evidence", "Artifacts require unique IDs, absolute paths and SHA-256 digests")
		}
		if (artifact.ArtifactId == nil) != (artifact.Version == nil) {
			Raise("invalid_evidence", "Artifacts require unique IDs, absolute paths and SHA-256 digests")
		}
		if artifact.ArtifactId != nil {
			if strings.TrimSpace(*artifact.ArtifactId) == "" || artifact.Version == nil ||
				!jsSafeInteger(int64(*artifact.Version)) || *artifact.Version < 1 {
				Raise("invalid_evidence", "Artifacts require unique IDs, absolute paths and SHA-256 digests")
			}
		}
	}
}

// OperationSnapshots lists the operations of one task.
func OperationSnapshots(store *TaskStore, taskId string, query OperationQuery) []OperationSnapshot {
	filters := []string{"task_id=?"}
	params := []any{taskId}
	if query.NodeId != nil {
		filters = append(filters, "node_id=?")
		params = append(params, *query.NodeId)
	}
	if query.After != nil || query.Before != nil {
		before := query.Before != nil
		if before {
			filters = append(filters, "rowid<COALESCE((SELECT rowid FROM operations WHERE task_id=? AND id=?),0)")
			params = append(params, taskId, *query.Before)
		} else {
			filters = append(filters, "rowid>COALESCE((SELECT rowid FROM operations WHERE task_id=? AND id=?),0)")
			params = append(params, taskId, *query.After)
		}
	}
	descending := query.Before != nil || (query.Latest && query.After == nil)
	limit := ""
	if query.Limit != nil {
		limit = " LIMIT ?"
		params = append(params, *query.Limit)
	}
	rows := kernelRows(store.Db, "SELECT * FROM operations WHERE "+strings.Join(filters, " AND ")+
		" ORDER BY rowid "+map[bool]string{true: "DESC", false: "ASC"}[descending]+limit, params...)
	if descending {
		for left, right := 0, len(rows)-1; left < right; left, right = left+1, right-1 {
			rows[left], rows[right] = rows[right], rows[left]
		}
	}
	out := make([]OperationSnapshot, 0, len(rows))
	for _, row := range rows {
		snapshot := operationSnapshotOf(row)
		out = append(out, *snapshot)
	}
	return out
}

// NodeOperationRuns lists the operation runs of one node.
func NodeOperationRuns(store *TaskStore, taskId, nodeId string) []OperationRun {
	rows := kernelRows(store.Db, `SELECT id,state,reserved,worker_active,waiting_slot,result,usage,dispatched_at,settled_at,waiting_ms,activation_id
    FROM operations WHERE task_id=? AND node_id=? ORDER BY rowid`, taskId, nodeId)
	out := make([]OperationRun, 0, len(rows))
	for _, row := range rows {
		waitingMs := kernelInt(row["waiting_ms"])
		var runMs *int64
		if row["dispatched_at"] != nil && row["settled_at"] != nil {
			value := kernelInt(row["settled_at"]) - kernelInt(row["dispatched_at"])
			if kernelInt(row["waiting_slot"]) != 0 {
				value -= NowMillis() - kernelInt(row["dispatched_at"])
			} else {
				value -= waitingMs
			}
			if value < 0 {
				value = 0
			}
			runMs = &value
		}
		run := OperationRun{
			Id:           kernelString(row["id"]),
			State:        kernelString(row["state"]),
			WorkerActive: kernelInt(row["worker_active"]) != 0,
			WaitingSlot:  kernelInt(row["waiting_slot"]) != 0,
			Reserved:     kernelInt(row["reserved"]),
			WaitingMs:    waitingMs,
			RunMs:        runMs,
			Result:       nil,
			Usage:        nil,
		}
		if row["activation_id"] != nil {
			value := kernelString(row["activation_id"])
			run.ActivationId = &value
		}
		if row["dispatched_at"] != nil {
			value := kernelInt(row["dispatched_at"])
			run.DispatchedAt = &value
		}
		if row["settled_at"] != nil {
			value := kernelInt(row["settled_at"])
			run.SettledAt = &value
		}
		if text := kernelString(row["result"]); text != "" {
			run.Result = parseJSON(text)
		}
		if text := kernelString(row["usage"]); text != "" {
			run.Usage = parseJSON(text)
		}
		out = append(out, run)
	}
	return out
}

// MarkOperationCredentialWait records that an operation waits for a credential slot.
func MarkOperationCredentialWait(store *TaskStore, operationId string, now ...int64) {
	at := NowMillis()
	if len(now) > 0 {
		at = now[0]
	}
	kernelExec(store.Db, "UPDATE operations SET waiting_slot=1,waiting_since=COALESCE(waiting_since,?) WHERE id=?", at, operationId)
}

// FinishOperationCredentialWait records that the credential slot is free again.
func FinishOperationCredentialWait(store *TaskStore, operationId string, now ...int64) {
	at := NowMillis()
	if len(now) > 0 {
		at = now[0]
	}
	kernelExec(store.Db, `UPDATE operations
    SET waiting_slot=0,waiting_ms=waiting_ms + MAX(0,?-COALESCE(waiting_since,?)),waiting_since=NULL
    WHERE id=?`, at, at, operationId)
}

// ClearOperationCredentialWait drops the credential wait without accounting for it.
func ClearOperationCredentialWait(store *TaskStore, operationId string) {
	kernelExec(store.Db, "UPDATE operations SET waiting_slot=0 WHERE id=?", operationId)
}

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
		kernelExec(lifecycle.store.Db, "UPDATE operations SET state='dispatched',worker_active=1,waiting_slot=0 WHERE id=?", operation.Id)
		lifecycle.store.ResolveOperationRecoveryQuestions(operation.Id, map[string]any{"proof": "Original durable input has its completed SDK receipt; unresolved usage remains unknown", "inputRequestId": receipt.InputRequestId})
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
