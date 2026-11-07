package graph

func RecoverMaster(store *TaskStore, taskId, reason string) bool {
	apply := func() any {
		master := questionMasterNode(store, taskId)
		if master == nil {
			return false
		}
		parked := kernelRows(store.Db, "SELECT id,kind,route_stage FROM questions WHERE task_id=? AND node_id=? AND status='open' AND owner='main'", taskId, master.Id)
		if reason == "configuration" {
			if len(parked) == 0 || kernelRow(store.Db, "SELECT id FROM questions WHERE task_id=? AND status='open' AND owner='user' LIMIT 1", taskId) != nil {
				return false
			}
		}
		released := []map[string]any{}
		if reason == "configuration" {
			for _, question := range parked {
				if question["route_stage"] == nil {
					released = append(released, question)
				}
			}
		} else {
			escalated := kernelRows(store.Db, "SELECT id,kind,route_stage FROM questions WHERE task_id=? AND node_id=? AND status='open' AND owner='user'", taskId, master.Id)
			for _, question := range append(parked, escalated...) {
				if questionPolicy(kernelString(question["kind"])).RetryOnMessage {
					released = append(released, question)
				}
			}
		}
		for _, question := range released {
			store.ResolveQuestion(kernelString(question["id"]), map[string]any{"type": "retry"})
		}
		if reason == "configuration" || len(released) > 0 || (master.Status != "preparing" && master.Status != "running" && master.Status != "blocked") {
			store.SetNodePending(taskId, master.Id)
		}
		if reason == "configuration" {
			store.Event(taskId, "task.master_recovered", map[string]any{"reason": "internal problem parked while the environment was unavailable"})
		}
		return len(released) > 0
	}
	if store.IsTransaction() {
		released, _ := apply().(bool)
		return released
	}
	released, _ := store.Transaction(apply).(bool)
	return released
}
