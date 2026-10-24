package graph

import (
	"encoding/json"
)

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
			l.store.SetNodePending(operation.TaskId, operation.NodeId)
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
