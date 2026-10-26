package graph

import (
	"strings"

	"encoding/json"
)

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
