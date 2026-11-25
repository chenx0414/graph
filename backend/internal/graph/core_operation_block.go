package graph

import (
	"encoding/json"
	"os"
	"time"
)

func (l *OperationLifecycle) HandleDispatchRefusal(operation Operation, refusal *RuntimeError, reservation int64) bool {
	refusalCodes := []string{"paused", "budget", "unknown_usage", "context_rejected", "interrupted"}
	if !containsString(refusalCodes, refusal.Code) {
		return false
	}
	if refusal.Code == "interrupted" && os.Getenv("GRAPH_DRAIN_CANCELED_USAGE") == "1" {
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			pending := kernelRow(l.store.Db, "SELECT 1 FROM invocations WHERE operation_id=? AND cost IS NULL LIMIT 1", operation.Id)
			if pending == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		l.store.Transaction(func(tx *TaskStore) {
		l := l.scoped(tx)
			for _, call := range kernelRows(l.store.Db, "SELECT id FROM invocations WHERE operation_id=? AND cost IS NULL", operation.Id) {
				l.store.RecordInvocationUsage(kernelString(call["id"]), nil, CanonicalJSON(map[string]any{"unknown": true}))
			}
		})
	}
	if refusal.Code != "interrupted" && refusal.Code != "budget" {
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
		if settledState == "interrupted" && unknown && refusal.Code == "interrupted" && os.Getenv("GRAPH_DRAIN_CANCELED_USAGE") == "1" {
			l.store.MarkOperationUnknown(operation.Id, 0)
		} else {
			l.store.MarkOperationUnsent(operation.Id, settledState, NowMillis())
		}
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
			if l.store.Task(operation.TaskId).Paused != 0 || PendingPauseContinuation(l.store, operation.TaskId, operation.NodeId) != nil {
				l.store.SetNodePending(operation.TaskId, operation.NodeId)
			} else {
				l.store.SetNodeStatus(operation.TaskId, operation.NodeId, "idle")
			}
			RecordConversationInterruption(l.store, operation, refusal.Message)
		default:
			if unknown || refusal.Code == "unknown_usage" {
				existing := kernelRow(l.store.Db, "SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'", operation.Id)
				if existing != nil {
					l.store.SetNodeBlocked(operation.TaskId, operation.NodeId)
				} else {
					l.Block(operation.TaskId, operation.NodeId, "unknown_usage", map[string]any{"reason": refusal.Message}, nil)
				}
			} else {
				l.store.SetNodePending(operation.TaskId, operation.NodeId)
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
		l.store.MarkOperationUnknown(operation.Id, active)
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
