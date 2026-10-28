package graph

// FindCreateRequest is the creation request a caller replayed, or nil.
//
// A request id is how a caller asks for the same graph twice. The request
// row is what makes the second ask the same as the first: it keeps the
// graph id, the definition that was asked for and the state the
// preparation reached.
func (k *KernelStore) FindCreateRequest(ownerTaskID, requestID string) *CreateRequest {
	row := kernelRow(k.Db, "SELECT graph_id,content,state FROM kernel_create_requests WHERE owner_task_id=? AND request_id=?", ownerTaskID, requestID)
	if row == nil {
		return nil
	}
	return &CreateRequest{
		OwnerTaskID: ownerTaskID,
		RequestID:   requestID,
		GraphID:     kernelString(row["graph_id"]),
		Content:     kernelString(row["content"]),
		State:       kernelString(row["state"]),
	}
}

// RecordCreateRequest keeps the request a graph was created from.
func (k *KernelStore) RecordCreateRequest(ownerTaskID, requestID, graphID, content, state string) {
	kernelExec(k.Db, "INSERT INTO kernel_create_requests(owner_task_id,request_id,graph_id,content,state) VALUES(?,?,?,?,?)",
		ownerTaskID, requestID, graphID, content, state)
}

// MarkCreateRequestReady says the preparation finished, so the graph may run.
func (k *KernelStore) MarkCreateRequestReady(ownerTaskID, requestID string) {
	kernelExec(k.Db, "UPDATE kernel_create_requests SET state='ready',error=NULL WHERE owner_task_id=? AND request_id=?", ownerTaskID, requestID)
}

// MarkCreateRequestPreparing records a retry before starting external preparation.
func (k *KernelStore) MarkCreateRequestPreparing(ownerTaskID, requestID string) {
	kernelExec(k.Db, "UPDATE kernel_create_requests SET state='preparing' WHERE owner_task_id=? AND request_id=? AND state='failed'", ownerTaskID, requestID)
}

// MarkCreateRequestFailed says the preparation failed, and why.
func (k *KernelStore) MarkCreateRequestFailed(ownerTaskID, requestID, reason string) {
	kernelExec(k.Db, "UPDATE kernel_create_requests SET state='failed',error=? WHERE owner_task_id=? AND request_id=?", reason, ownerTaskID, requestID)
}

// RecordGraphOwner says which task owns a graph.
func (k *KernelStore) RecordGraphOwner(graphID, ownerTaskID string) {
	kernelExec(k.Db, "INSERT INTO kernel_graph_owners(task_id,owner_task_id) VALUES(?,?)", graphID, ownerTaskID)
}

// TransferGraphOwner changes the active supervisor without changing the graph's source task.
func (k *KernelStore) TransferGraphOwner(graphID, ownerTaskID string) {
	kernelExec(k.Db, `INSERT INTO kernel_graph_owners(task_id,owner_task_id) VALUES(?,?)
 ON CONFLICT(task_id) DO UPDATE SET owner_task_id=excluded.owner_task_id`, graphID, ownerTaskID)
}

// GraphOwner is the task that owns a graph, when it has an owner.
func (k *KernelStore) GraphOwner(graphID string) (string, bool) {
	row := kernelRow(k.Db, "SELECT owner_task_id FROM kernel_graph_owners WHERE task_id=?", graphID)
	if row == nil {
		return "", false
	}
	return kernelString(row["owner_task_id"]), true
}
