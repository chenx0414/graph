package graph

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

func (k *KernelStore) RecordCreateRequest(ownerTaskID, requestID, graphID, content, state string) {
	kernelExec(k.Db, "INSERT INTO kernel_create_requests(owner_task_id,request_id,graph_id,content,state) VALUES(?,?,?,?,?)",
		ownerTaskID, requestID, graphID, content, state)
}

func (k *KernelStore) MarkCreateRequestReady(ownerTaskID, requestID string) {
	kernelExec(k.Db, "UPDATE kernel_create_requests SET state='ready',error=NULL WHERE owner_task_id=? AND request_id=?", ownerTaskID, requestID)
}

func (k *KernelStore) MarkCreateRequestPreparing(ownerTaskID, requestID string) {
	kernelExec(k.Db, "UPDATE kernel_create_requests SET state='preparing' WHERE owner_task_id=? AND request_id=? AND state='failed'", ownerTaskID, requestID)
}

func (k *KernelStore) MarkCreateRequestFailed(ownerTaskID, requestID, reason string) {
	kernelExec(k.Db, "UPDATE kernel_create_requests SET state='failed',error=? WHERE owner_task_id=? AND request_id=?", reason, ownerTaskID, requestID)
}

func (k *KernelStore) RecordGraphOwner(graphID, ownerTaskID string) {
	kernelExec(k.Db, "INSERT INTO kernel_graph_owners(task_id,owner_task_id) VALUES(?,?)", graphID, ownerTaskID)
}

func (k *KernelStore) TransferGraphOwner(graphID, ownerTaskID string) {
	kernelExec(k.Db, `INSERT INTO kernel_graph_owners(task_id,owner_task_id) VALUES(?,?)
 ON CONFLICT(task_id) DO UPDATE SET owner_task_id=excluded.owner_task_id`, graphID, ownerTaskID)
}

func (k *KernelStore) GraphOwner(graphID string) (string, bool) {
	row := kernelRow(k.Db, "SELECT owner_task_id FROM kernel_graph_owners WHERE task_id=?", graphID)
	if row == nil {
		return "", false
	}
	return kernelString(row["owner_task_id"]), true
}
