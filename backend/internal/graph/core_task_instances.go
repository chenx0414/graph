package graph

import "encoding/json"

func (s *TaskStore) CreateInstance(id, taskID, nodeID string, definitionVersion, model *string, budget int64, unlimited int) {
	kernelExec(s.DB, "INSERT INTO instances(id,task_id,node_id,definition_version,model,budget,unlimited) VALUES(?,?,?,?,?,?,?)",
		id, taskID, nodeID, definitionVersion, model, budget, unlimited)
}

func instanceDefinitionVersion(value any) *string {
	if value == nil {
		return nil
	}
	text := g5Str(value)
	return &text
}

func (s *TaskStore) SetInstanceModel(instanceID, model string) {
	kernelExec(s.DB, "UPDATE instances SET model=? WHERE id=?", model, instanceID)
}

func (s *TaskStore) SetInstanceDefinition(instanceID string, definitionVersion *string) {
	kernelExec(s.DB, "UPDATE instances SET definition_version=? WHERE id=?", definitionVersion, instanceID)
}

func (s *TaskStore) SetInstanceModelAndDefinition(instanceID, model string, definitionVersion *string) {
	kernelExec(s.DB, "UPDATE instances SET model=?,definition_version=? WHERE id=?", model, definitionVersion, instanceID)
}

func (s *TaskStore) JoinBudgetScope(instanceID, scopeID string) {
	kernelExec(s.DB, "UPDATE instances SET budget_scope_id=? WHERE id=?", scopeID, instanceID)
}

func (s *TaskStore) TakeSharedBudget(instanceID, scopeID string, limit int64, unlimited int) {
	kernelExec(s.DB, "UPDATE instances SET budget_scope_id=?,budget=?,unlimited=? WHERE id=?", scopeID, limit, unlimited, instanceID)
}

func (s *TaskStore) SetInstanceBudget(instanceID string, budget int64, unlimited int) {
	kernelExec(s.DB, "UPDATE instances SET budget=?,unlimited=? WHERE id=?", budget, unlimited, instanceID)
}

func (s *TaskStore) SetScopeMemberBudget(scopeID string, budget int64, unlimited int) {
	kernelExec(s.DB, "UPDATE instances SET budget=?,unlimited=? WHERE budget_scope_id=?", budget, unlimited, scopeID)
}

func (s *TaskStore) AddInstanceBudget(instanceID string, tokens int64) {
	kernelExec(s.DB, "UPDATE instances SET budget=budget+? WHERE id=?", tokens, instanceID)
}

func (s *TaskStore) SyncScopeMemberBudget(scopeID string) {
	kernelExec(s.DB, "UPDATE instances SET budget=COALESCE((SELECT limit_tokens FROM budget_scopes WHERE id=?),0) WHERE budget_scope_id=?", scopeID, scopeID)
}

func (s *TaskStore) AddInstanceUsage(instanceID string, total int64) {
	kernelExec(s.DB, "UPDATE instances SET used=used+? WHERE id=?", total, instanceID)
}

func (s *TaskStore) InstanceModelsUsed(instanceID string) []string {
	row, ok := g5One(s.DB, "SELECT models_used FROM instances WHERE id=?", instanceID)
	if !ok {
		Raise("not_found", "Unknown instance")
	}
	var used []string
	if err := json.Unmarshal([]byte(g5Str(row["models_used"])), &used); err != nil {
		panic(err)
	}
	if used == nil {
		return []string{}
	}
	return used
}

func (s *TaskStore) SetInstanceModelsUsed(instanceID string, models []string) {
	encoded, err := json.Marshal(models)
	if err != nil {
		panic(err)
	}
	kernelExec(s.DB, "UPDATE instances SET models_used=? WHERE id=?", string(encoded), instanceID)
}
