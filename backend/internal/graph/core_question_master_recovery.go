package graph

// RecoverMaster releases a master for an explicit message or configuration
// change. Startup does not call this: simply reopening the runtime must leave
// problems parked. It reports whether a parked problem was resolved. Writes
// join an existing command/recovery transaction, or open one when called on
// its own.
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
			// A message is somebody asking this master for a turn. A problem that was
			// escalated to the person stops being owner 'main', and leaving it open kept
			// the node blocked: measured 2026-11-04, one recovery escalated to the user
			// made a project supervisor unreachable for hours while its message sat in
			// the queue. Both owners are read here, because a retry-on-message problem
			// is answered by the message itself whoever it is parked on.
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
		// Releasing a problem is what makes the node answerable again, so the node is
		// re-pended whenever something was released - including the blocked case that
		// used to be skipped and left the message queued forever.
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
