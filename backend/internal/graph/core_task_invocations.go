package graph

import (
	"encoding/json"
)

// InvocationRow is one recorded provider invocation.
type InvocationRow struct {
	Id          string      `json:"id"`
	OperationId string      `json:"operationId"`
	InstanceId  string      `json:"instanceId"`
	Model       string      `json:"model"`
	Usage       *TokenUsage `json:"usage"`
	UsageSource UsageSource `json:"usageSource"`
	Cost        any         `json:"cost"`
}

// OperationNode is the node an operation ran on.
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

// OpenUnknownUsageQuestion reports whether a node is held by an open question
// about usage nobody can account for.
func (s *TaskStore) OpenUnknownUsageQuestion(taskID, nodeID string) bool {
	return kernelRow(s.DB, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND kind='unknown_usage' AND status='open' AND owner='user'", taskID, nodeID) != nil
}

// OpenUnknownUsageQuestionForOperation reports whether an operation is held
// by an open question about usage nobody can account for.
func (s *TaskStore) OpenUnknownUsageQuestionForOperation(operationID string) bool {
	return kernelRow(s.DB, "SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'", operationID) != nil
}

// InvocationExists reports whether an invocation was already dispatched.
func (s *TaskStore) InvocationExists(id string) bool {
	return kernelRow(s.DB, "SELECT id FROM invocations WHERE id=?", id) != nil
}

// OpenInvocation records a model call that is about to happen.
//
// The underlying upstream identity is frozen here, not just the mutable
// connection id: review independence reads this history later.
func (s *TaskStore) OpenInvocation(id, operationID, instanceID, model, purpose string) {
	if _, err := s.DB.Exec("INSERT INTO invocations(id,operation_id,instance_id,model,purpose,dispatched_at) VALUES(?,?,?,?,?,?)",
		id, operationID, instanceID, model, purpose, NowMillis()); err != nil {
		panic(err)
	}
}

// InvocationUsage is the usage one invocation recorded.
//
// A found row with a nil usage has not settled yet. The caller must not read
// that as a recorded empty usage, so the usage stays a pointer.
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

// RecordInvocationUsage records what an invocation cost.
func (s *TaskStore) RecordInvocationUsage(id string, usage, cost any) {
	if _, err := s.DB.Exec("UPDATE invocations SET usage=?,cost=?,settled_at=? WHERE id=?", usage, cost, NowMillis(), id); err != nil {
		panic(err)
	}
}

// InvocationRows are the invocations one task recorded, oldest first.
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
