package graph

import "encoding/json"

type BudgetSnapshot struct {
	InstanceId     string  `json:"instanceId"`
	Budget         int64   `json:"budget"`
	Used           int64   `json:"used"`
	Unlimited      bool    `json:"unlimited"`
	Reserved       int64   `json:"reserved"`
	ScopeId        *string `json:"scopeId"`
	ScopeLimit     *int64  `json:"scopeLimit"`
	ScopeUsed      int64   `json:"scopeUsed"`
	ScopeUnlimited bool    `json:"scopeUnlimited"`
}

type BudgetScopeView struct {
	Id              string  `json:"id"`
	RootTaskId      *string `json:"rootTaskId"`
	OwnerInstanceId *string `json:"ownerInstanceId"`
	Members         int64   `json:"members"`
	Used            int64   `json:"used"`
	Limit           *int64  `json:"limit"`
	Unlimited       bool    `json:"unlimited"`
}

func budgetLedgerTokenTotal(usage TokenUsage) int64 {
	return usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite
}

func instanceBudget(store *TaskStore, instanceID string) map[string]any {
	row, ok := g5One(store.Db, "SELECT id,budget,used,unlimited,budget_scope_id FROM instances WHERE id=?", instanceID)
	if !ok {
		Raise("not_found", "Unknown instance budget")
	}
	return row
}

// EnsureBudgetScope establishes the durable scope shared by an instance and its forks.
func EnsureBudgetScope(store *TaskStore, taskID, instanceID string) string {
	instance := instanceBudget(store, instanceID)
	if instance["budget_scope_id"] != nil {
		return g5Str(instance["budget_scope_id"])
	}
	id := graphUUID()
	unlimited := g5Int(instance["unlimited"]) != 0
	var limit any
	if !unlimited {
		limit = g5Int(instance["budget"])
	}
	g5Exec(store.Db, `INSERT INTO budget_scopes(
    id,task_id,root_task_id,owner_instance_id,limit_tokens,unlimited,used_tokens,created_at
  ) VALUES(?,?,?,?,?,?,?,?)`, id, taskID, taskID, g5Str(instance["id"]), limit, boolInt(unlimited), g5Int(instance["used"]), NowMillis())
	store.JoinBudgetScope(g5Str(instance["id"]), id)
	return id
}

func BudgetScopeViewOf(store *TaskStore, scopeID string) *BudgetScopeView {
	row, ok := g5One(store.Db, `SELECT s.id,s.root_task_id,s.owner_instance_id,s.limit_tokens,s.unlimited,s.used_tokens,
      (SELECT COUNT(*) FROM instances member WHERE member.budget_scope_id=s.id) AS members
    FROM budget_scopes s WHERE s.id=?`, scopeID)
	if !ok {
		return nil
	}
	view := &BudgetScopeView{
		Id: g5Str(row["id"]), Members: g5Int(row["members"]), Used: g5Int(row["used_tokens"]), Unlimited: g5Int(row["unlimited"]) != 0,
	}
	if row["root_task_id"] != nil {
		text := g5Str(row["root_task_id"])
		view.RootTaskId = &text
	}
	if row["owner_instance_id"] != nil {
		text := g5Str(row["owner_instance_id"])
		view.OwnerInstanceId = &text
	}
	if !view.Unlimited && row["limit_tokens"] != nil {
		limit := g5Int(row["limit_tokens"])
		view.Limit = &limit
	}
	return view
}

func LoadBudgetSnapshot(store *TaskStore, instanceID string) BudgetSnapshot {
	instance := instanceBudget(store, instanceID)
	reservedRow, _ := g5One(store.Db, "SELECT COALESCE(SUM(reserved),0) AS reserved FROM operations WHERE instance_id=?", instanceID)
	var scope *BudgetScopeView
	var scopeID *string
	if instance["budget_scope_id"] != nil {
		id := g5Str(instance["budget_scope_id"])
		scopeID = &id
		scope = BudgetScopeViewOf(store, id)
	}
	snapshot := BudgetSnapshot{
		InstanceId: instanceID, Budget: g5Int(instance["budget"]), Used: g5Int(instance["used"]),
		Unlimited: g5Int(instance["unlimited"]) != 0, Reserved: g5Int(reservedRow["reserved"]),
		ScopeId: scopeID, ScopeUsed: 0, ScopeUnlimited: true,
	}
	if scope != nil {
		snapshot.ScopeLimit = scope.Limit
		snapshot.ScopeUsed = scope.Used
		snapshot.ScopeUnlimited = scope.Unlimited
	}
	return snapshot
}

// UnknownUsageIsNonBlocking is true when an unlimited instance can record missing usage without a question.
func UnknownUsageIsNonBlocking(store *TaskStore, instanceID string) bool {
	if instanceID == "" {
		return false
	}
	row, ok := g5One(store.Db, "SELECT unlimited FROM instances WHERE id=?", instanceID)
	return ok && g5Int(row["unlimited"]) != 0
}

func scopeInFlightUsage(store *TaskStore, scopeID string) int64 {
	rows := g5Query(store.Db, `SELECT i.usage FROM invocations i
    JOIN operations o ON o.id=i.operation_id
    JOIN instances n ON n.id=i.instance_id
    WHERE n.budget_scope_id=? AND o.state IN ('intent','dispatched','unknown') AND i.usage IS NOT NULL`, scopeID)
	var sum int64
	for _, row := range rows {
		var usage TokenUsage
		if err := json.Unmarshal([]byte(g5Str(row["usage"])), &usage); err != nil {
			panic(err)
		}
		sum += budgetLedgerTokenTotal(usage)
	}
	return sum
}

func scopeReserved(store *TaskStore, scopeID string) int64 {
	row, _ := g5One(store.Db, `SELECT COALESCE(SUM(o.reserved),0) AS reserved FROM operations o
    JOIN instances i ON i.id=o.instance_id WHERE i.budget_scope_id=?`, scopeID)
	return g5Int(row["reserved"])
}

func ReserveOperation(store *TaskStore, operationID string, amount int64) {
	if !g5SafeInt(amount) || amount < 0 {
		Raise("invalid_adapter", "A bounded token reservation is required")
	}
	if !store.TakeOperationReservation(operationID, amount) {
		Raise("invalid_operation", "Operation reservation is no longer available")
	}
}

func ReleaseOperationReservation(store *TaskStore, operationID string) {
	store.ClearOperationReservation(operationID)
}

func CommitUsage(store *TaskStore, instanceID string, total int64) {
	if !g5SafeInt(total) || total < 0 {
		Raise("invalid_input", "Usage total must be a nonnegative integer")
	}
	instance := instanceBudget(store, instanceID)
	if total > 0 {
		store.AddInstanceUsage(instanceID, total)
		if instance["budget_scope_id"] != nil {
			g5Exec(store.Db, "UPDATE budget_scopes SET used_tokens=used_tokens+? WHERE id=?", total, instance["budget_scope_id"])
		}
	}
}

func ModelsUsed(store *TaskStore, instanceID string) []string {
	return store.InstanceModelsUsed(instanceID)
}

func RecordModelUse(store *TaskStore, instanceID, model string) {
	if model == "" {
		return
	}
	used := ModelsUsed(store, instanceID)
	for _, item := range used {
		if item == model {
			return
		}
	}
	store.SetInstanceModelsUsed(instanceID, append(used, model))
}

func RecordCurrentModelUse(store *TaskStore, instanceID string) {
	if instanceID == "" {
		return
	}
	row, ok := g5One(store.Db, "SELECT model FROM instances WHERE id=?", instanceID)
	if ok && row["model"] != nil {
		RecordModelUse(store, instanceID, g5Str(row["model"]))
	}
}

func SetBudget(store *TaskStore, instanceID string, tokens *int64) {
	if tokens != nil && (!g5SafeInt(*tokens) || *tokens <= 0) {
		Raise("invalid_input", "Budget must be a positive integer or null")
	}
	row := instanceBudget(store, instanceID)
	if row["budget_scope_id"] != nil {
		scope, ok := g5One(store.Db, `SELECT s.owner_instance_id,
        (SELECT COUNT(*) FROM instances member WHERE member.budget_scope_id=s.id) AS members
      FROM budget_scopes s WHERE s.id=?`, row["budget_scope_id"])
		if ok && g5Int(scope["members"]) > 1 && g5Str(scope["owner_instance_id"]) != instanceID {
			Raise("shared_budget_owner_required", "Only the shared budget owner can change the scope cap")
		}
	}
	budget := int64(0)
	unlimited := 0
	var limit any
	if tokens == nil {
		unlimited = 1
	} else {
		budget = *tokens
		limit = *tokens
	}
	store.SetInstanceBudget(instanceID, budget, unlimited)
	if row["budget_scope_id"] != nil {
		g5Exec(store.Db, "UPDATE budget_scopes SET limit_tokens=?,unlimited=? WHERE id=?", limit, unlimited, row["budget_scope_id"])
		store.SetScopeMemberBudget(g5Str(row["budget_scope_id"]), budget, unlimited)
	}
}

func AddBudget(store *TaskStore, instanceID string, tokens int64) {
	if !g5SafeInt(tokens) || tokens <= 0 {
		Raise("invalid_input", "A positive token increment is required")
	}
	row := instanceBudget(store, instanceID)
	if g5Int(row["unlimited"]) != 0 {
		Raise("invalid_answer", "An unlimited instance has no budget question to add to")
	}
	if !g5SafeInt(g5Int(row["budget"]) + tokens) {
		Raise("invalid_answer", "Budget exceeds the supported range")
	}
	store.AddInstanceBudget(instanceID, tokens)
	if row["budget_scope_id"] != nil {
		scope, _ := g5One(store.Db, "SELECT limit_tokens,unlimited FROM budget_scopes WHERE id=?", row["budget_scope_id"])
		if g5Int(scope["unlimited"]) == 0 {
			g5Exec(store.Db, "UPDATE budget_scopes SET limit_tokens=COALESCE(limit_tokens,0)+? WHERE id=?", tokens, row["budget_scope_id"])
			store.SyncScopeMemberBudget(g5Str(row["budget_scope_id"]))
		}
	}
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
