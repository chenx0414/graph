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
	if _, err := s.DB.Exec("INSERT INTO invocations(id,operation_id,instance_id,model,purpose,dispatched_at) VALUES(?,?,?,?,?,?)",
		id, operationID, instanceID, model, purpose, NowMillis()); err != nil {
		panic(err)
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
	if _, err := s.DB.Exec("UPDATE invocations SET usage=?,cost=?,settled_at=? WHERE id=?", usage, cost, NowMillis(), id); err != nil {
		panic(err)
	}
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
