package graph

import "database/sql"

// CreateActivation keeps the external main's activation identity outside native graphs.
func CreateActivation(store *TaskStore, taskID, nodeID string, graphVersion int, round ...int) string {
	which := 1
	if len(round) > 0 {
		which = round[0]
	}
	id := graphUUID()
	if _, err := store.Db.Exec(
		"INSERT INTO activations(id,task_id,node_id,graph_version,round,state,input_versions) VALUES(?,?,?,?,?,'pending','{}')",
		id, taskID, nodeID, graphVersion, which,
	); err != nil {
		panic(err)
	}
	if _, err := store.Db.Exec("UPDATE nodes SET activation_id=? WHERE task_id=? AND id=?", id, taskID, nodeID); err != nil {
		panic(err)
	}
	return id
}

func HasLockedQuestion(store *TaskStore, taskID, nodeID string) bool {
	var instanceID sql.NullString
	err := store.Db.QueryRow("SELECT instance_id FROM nodes WHERE task_id=? AND id=?", taskID, nodeID).Scan(&instanceID)
	if err != nil && err != sql.ErrNoRows {
		panic(err)
	}
	var instance *string
	if instanceID.Valid {
		value := instanceID.String
		instance = &value
	}
	kinds := "kind IN ('budget','unknown_usage','reservation_exceeded','permission')"
	if UnknownUsageIsNonBlocking(store, queueText(instance)) {
		kinds = "kind IN ('budget','reservation_exceeded','permission')"
	}
	var id string
	err = store.Db.QueryRow(
		"SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open' AND "+kinds,
		taskID, nodeID,
	).Scan(&id)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		panic(err)
	}
	return true
}
