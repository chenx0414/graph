package graph

// PeerNode is one other Agent of a graph, so it can be addressed by name.
type PeerNode struct {
	Id     string  `json:"id"`
	Status string  `json:"status"`
	Role   *string `json:"role"`
}

// PeerNodes lists the other Agents of this graph.
func PeerNodes(store *TaskStore, taskId string) []PeerNode {
	store.Task(taskId)
	rows := kernelRows(store.DB, "SELECT id,status,json_extract(spec,'$.role') AS role FROM nodes WHERE task_id=? ORDER BY rowid", taskId)
	out := make([]PeerNode, 0, len(rows))
	for _, row := range rows {
		peer := PeerNode{Id: kernelString(row["id"]), Status: kernelString(row["status"])}
		if row["role"] != nil {
			role := kernelString(row["role"])
			peer.Role = &role
		}
		out = append(out, peer)
	}
	return out
}
