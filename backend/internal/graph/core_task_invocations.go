package graph

import (
	"encoding/json"
)

type InvocationRow struct {
	Id          string      `json:"id"`
	OperationId string      `json:"operationId"`
	InstanceId  string      `json:"instanceId"`
	Model       string      `json:"model"`
	Usage       *TokenUsage `json:"usage"`
	UsageSource UsageSource `json:"usageSource"`
	Cost        any         `json:"cost"`
}

func (s *TaskStore) OperationNode(operationID string) (nodeID string, found bool) {
	row := kernelRow(s.DB, "SELECT node_id FROM operations WHERE id=?", operationID)
	if row == nil {
		return "", false
	}
	value, ok := row["node_id"]
	if !ok || value == nil {
		return "", false
	}
	return kernelString(value), true
}

func (s *TaskStore) OpenUnknownUsageQuestion(taskID, nodeID string) bool {
	return kernelRow(s.DB, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND kind='unknown_usage' AND status='open' AND owner='user'", taskID, nodeID) != nil
}

func (s *TaskStore) OpenUnknownUsageQuestionForOperation(operationID string) bool {
	return kernelRow(s.DB, "SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'", operationID) != nil
}

func (s *TaskStore) InvocationExists(id string) bool {
	return kernelRow(s.DB, "SELECT id FROM invocations WHERE id=?", id) != nil
}

func (s *TaskStore) OpenInvocation(id, operationID, instanceID, model, purpose string) {
	taskID := ""
	if row := kernelRow(s.Db, "SELECT task_id FROM operations WHERE id=?", operationID); row != nil {
		taskID = kernelString(row["task_id"])
	}
	_, cached := taskInvocationCachedTotals(s, taskID)
	if _, err := s.DB.Exec("INSERT INTO invocations(id,operation_id,instance_id,model,purpose,dispatched_at) VALUES(?,?,?,?,?,?)",
		id, operationID, instanceID, model, purpose, NowMillis()); err != nil {
		panic(err)
	}
	if taskID != "" && cached {
		totals, _ := taskInvocationCachedTotals(s, taskID)
		totals.Invocations++
		totals.CostUnknown++
		s.saveTaskInvocationTotals(taskID, totals)
	}
	if composition := invocationComposition(s, operationID); composition != "" {
		if _, err := s.DB.Exec("UPDATE invocations SET composition=? WHERE id=?", composition, id); err != nil {
			panic(err)
		}
	}
}

func invocationComposition(store *TaskStore, operationID string) string {
	operation := kernelRow(store.Db, `SELECT task_id,COALESCE(system_prompt,'') AS system_prompt,
		COALESCE(tool_declarations,'') AS tool_declarations FROM operations WHERE id=?`, operationID)
	if operation == nil {
		return ""
	}
	composition := TrajectoryComposition{
		SystemPrompt:    estimateTrajectoryTokens(kernelString(operation["system_prompt"])),
		ToolDefinitions: estimateTrajectoryTokens(kernelString(operation["tool_declarations"])),
	}
	if conversation := ConversationForTask(store, kernelString(operation["task_id"])); conversation != nil {
		rows := kernelRows(store.Db, `SELECT role,kind,SUM(LENGTH(text)) AS chars,
			SUM(LENGTH(CAST(text AS BLOB))) AS bytes FROM messages WHERE conversation_id=? GROUP BY role,kind`, conversation.Id)
		for _, row := range rows {
			chars := kernelInt(row["chars"])
			wide := (kernelInt(row["bytes"]) - chars) / 2
			tokens := wide + (chars-wide+3)/4
			switch role, kind := kernelString(row["role"]), kernelString(row["kind"]); {
			case role == "user" && kind == "chat":
				composition.UserMessages += tokens
			case role == "assistant" && kind == "chat":
				composition.AssistantReply += tokens
			case role == "tool" && kind == "tool":
				composition.ToolCalls += tokens
			case role == "system" && kind != "rsi" && kind != "activity":
				composition.Injected += tokens
			}
		}
	}
	payload, err := json.Marshal(composition)
	if err != nil {
		return ""
	}
	return string(payload)
}

func (s *TaskStore) InvocationUsage(id string) (*string, bool) {
	row := kernelRow(s.DB, "SELECT usage FROM invocations WHERE id=?", id)
	if row == nil {
		return nil, false
	}
	value, ok := row["usage"]
	if !ok || value == nil {
		return nil, true
	}
	recorded := kernelString(value)
	return &recorded, true
}

func (s *TaskStore) RecordInvocationUsage(id string, usage, cost any) {
	row := kernelRow(s.Db, `SELECT i.usage AS oldUsage,i.cost AS oldCost,i.purpose AS purpose,i.rowid AS rowid,
       i.dispatched_at AS dispatchedAt,o.task_id AS taskId
    FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE i.id=?`, id)
	if row == nil {
		return
	}
	taskID := kernelString(row["taskId"])
	cached := kernelRow(s.Db, "SELECT task_id FROM task_invocation_totals WHERE task_id=?", taskID) != nil
	settled := NowMillis()
	if _, err := s.DB.Exec("UPDATE invocations SET usage=?,cost=?,settled_at=? WHERE id=?", usage, cost, settled, id); err != nil {
		panic(err)
	}
	if !cached {
		s.ensureTaskInvocationTotals(taskID)
		return
	}
	totals := s.ensureTaskInvocationTotals(taskID)
	totals.apply(kernelString(row["oldUsage"]), kernelString(row["oldCost"]), kernelString(row["purpose"]),
		kernelInt(row["rowid"]), kernelInt(row["dispatchedAt"]), 0, -1)
	totals.apply(kernelString(usageToText(usage)), kernelString(costToText(cost)), kernelString(row["purpose"]),
		kernelInt(row["rowid"]), kernelInt(row["dispatchedAt"]), settled, 1)
	s.saveTaskInvocationTotals(taskID, totals)
}

func usageToText(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	payload, _ := json.Marshal(value)
	return string(payload)
}

func costToText(value any) string {
	return usageToText(value)
}

func (s *TaskStore) InvocationRows(taskID string) []InvocationRow {
	rows := kernelRows(s.DB, "SELECT i.id,i.operation_id,i.instance_id,i.model,i.usage,i.cost FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE o.task_id=? ORDER BY i.rowid", taskID)
	out := []InvocationRow{}
	for _, row := range rows {
		entry := InvocationRow{
			Id:          kernelString(row["id"]),
			OperationId: kernelString(row["operation_id"]),
			InstanceId:  kernelString(row["instance_id"]),
			Model:       kernelString(row["model"]),
		}
		if recorded, ok := row["usage"].(string); ok && recorded != "" {
			var usage TokenUsage
			if err := json.Unmarshal([]byte(recorded), &usage); err != nil {
				panic(err)
			}
			entry.Usage = &usage
		}
		entry.UsageSource = UsageSourceOf(entry.Usage)
		if recorded, ok := row["cost"].(string); ok && recorded != "" {
			var cost any
			if err := json.Unmarshal([]byte(recorded), &cost); err != nil {
				panic(err)
			}
			entry.Cost = cost
		}
		out = append(out, entry)
	}
	return out
}
