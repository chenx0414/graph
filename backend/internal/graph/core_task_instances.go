package graph

import "encoding/json"

// CreateInstance adds one instance of a node.
func (s *TaskStore) CreateInstance(id, taskID, nodeID string, definitionVersion, model *string, budget int64, unlimited int) {
	kernelExec(s.DB, "INSERT INTO instances(id,task_id,node_id,definition_version,model,budget,unlimited) VALUES(?,?,?,?,?,?,?)",
		id, taskID, nodeID, definitionVersion, model, budget, unlimited)
}

// instanceDefinitionVersion is the definition version an instance runs,
// which may be absent.
func instanceDefinitionVersion(value any) *string {
	if value == nil {
		return nil
	}
	text := g5Str(value)
	return &text
}

// SetInstanceModel says which model the instance runs.
func (s *TaskStore) SetInstanceModel(instanceID, model string) {
	kernelExec(s.DB, "UPDATE instances SET model=? WHERE id=?", model, instanceID)
}

// SetInstanceDefinition says which definition version the instance runs.
func (s *TaskStore) SetInstanceDefinition(instanceID string, definitionVersion *string) {
	kernelExec(s.DB, "UPDATE instances SET definition_version=? WHERE id=?", definitionVersion, instanceID)
}

// SetInstanceModelAndDefinition says which model and which definition
// version the instance runs.
func (s *TaskStore) SetInstanceModelAndDefinition(instanceID, model string, definitionVersion *string) {
	kernelExec(s.DB, "UPDATE instances SET model=?,definition_version=? WHERE id=?", model, definitionVersion, instanceID)
}

// JoinBudgetScope says the instance spends from a shared budget scope.
func (s *TaskStore) JoinBudgetScope(instanceID, scopeID string) {
	kernelExec(s.DB, "UPDATE instances SET budget_scope_id=? WHERE id=?", scopeID, instanceID)
}

// TakeSharedBudget says the instance spends from a shared budget scope, and
// takes that scope's cap.
func (s *TaskStore) TakeSharedBudget(instanceID, scopeID string, limit int64, unlimited int) {
	kernelExec(s.DB, "UPDATE instances SET budget_scope_id=?,budget=?,unlimited=? WHERE id=?", scopeID, limit, unlimited, instanceID)
}

// SetInstanceBudget sets the cap of one instance.
func (s *TaskStore) SetInstanceBudget(instanceID string, budget int64, unlimited int) {
	kernelExec(s.DB, "UPDATE instances SET budget=?,unlimited=? WHERE id=?", budget, unlimited, instanceID)
}

// SetScopeMemberBudget sets the cap of every instance in a scope.
func (s *TaskStore) SetScopeMemberBudget(scopeID string, budget int64, unlimited int) {
	kernelExec(s.DB, "UPDATE instances SET budget=?,unlimited=? WHERE budget_scope_id=?", budget, unlimited, scopeID)
}

// AddInstanceBudget grows the cap of one instance.
func (s *TaskStore) AddInstanceBudget(instanceID string, tokens int64) {
	kernelExec(s.DB, "UPDATE instances SET budget=budget+? WHERE id=?", tokens, instanceID)
}

// SyncScopeMemberBudget gives the scope's members the scope's cap.
func (s *TaskStore) SyncScopeMemberBudget(scopeID string) {
	kernelExec(s.DB, "UPDATE instances SET budget=COALESCE((SELECT limit_tokens FROM budget_scopes WHERE id=?),0) WHERE budget_scope_id=?", scopeID, scopeID)
}

// AddInstanceUsage records the tokens one instance spent.
func (s *TaskStore) AddInstanceUsage(instanceID string, total int64) {
	kernelExec(s.DB, "UPDATE instances SET used=used+? WHERE id=?", total, instanceID)
}

// InstanceModelsUsed are the models one instance ran.
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

// SetInstanceModelsUsed records the models one instance ran.
func (s *TaskStore) SetInstanceModelsUsed(instanceID string, models []string) {
	encoded, err := json.Marshal(models)
	if err != nil {
		panic(err)
	}
	kernelExec(s.DB, "UPDATE instances SET models_used=? WHERE id=?", string(encoded), instanceID)
}
