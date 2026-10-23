package graph

// The module operations of a delivery.
//
// The operation broker used to read and write kernel_module_operations with
// SQL of its own, so the shape of that table was known in two places. The
// store owns it now.

// KernelModuleOperation is one module operation of a delivery.
type KernelModuleOperation struct {
	// Id is the operation's identity.
	Id string
	// State is where the operation stands.
	State string
	// Result is what the operation published.
	Result string
}

// ModuleOperationOfDelivery is the operation a delivery already carries.
func (k *KernelStore) ModuleOperationOfDelivery(deliveryID string) *KernelModuleOperation {
	row, ok := g5One(k.Db, "SELECT id,state,result FROM kernel_module_operations WHERE delivery_id=?", deliveryID)
	if !ok {
		return nil
	}
	return &KernelModuleOperation{Id: g5Str(row["id"]), State: g5Str(row["state"]), Result: g5Str(row["result"])}
}

// PrepareModuleOperation records the operation a delivery is about to run.
func (k *KernelStore) PrepareModuleOperation(id, taskID, moduleID, deliveryID string, revisionVersion int, request string, created int64) {
	g5Exec(k.Db, `INSERT INTO kernel_module_operations(id,task_id,module_id,delivery_id,revision_version,request,state,created_at)
	VALUES(?,?,?,?,?,?,'prepared',?) ON CONFLICT(delivery_id) DO UPDATE SET request=excluded.request,revision_version=excluded.revision_version,state='prepared',error=NULL,resource_receipt=NULL,record_digest=NULL`,
		id, taskID, moduleID, deliveryID, revisionVersion, request, created)
}

// DispatchModuleOperation marks the operation as sent. It reports whether
// this call is the one that sent it.
func (k *KernelStore) DispatchModuleOperation(id string) (bool, error) {
	result := kernelExec(k.Db, "UPDATE kernel_module_operations SET state='dispatched',started_at=? WHERE id=? AND state='prepared'", NowMillis(), id)
	count, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return count == 1, nil
}

// ReleaseModuleOperationWorker frees the worker an operation holds.
func (k *KernelStore) ReleaseModuleOperationWorker(id string) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET worker_active=0 WHERE id=?", id)
}

// ModuleOperationPrepared reports whether an operation is still waiting to
// be sent.
func (k *KernelStore) ModuleOperationPrepared(id string) bool {
	_, ok := g5One(k.Db, "SELECT 1 FROM kernel_module_operations WHERE id=? AND state='prepared'", id)
	return ok
}

// FailModuleOperation records an operation that did not finish. One that was
// already sent is uncertain rather than failed: it may have had its effect.
func (k *KernelStore) FailModuleOperation(id, reason string, ended int64) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET state=CASE WHEN state='dispatched' THEN 'uncertain' ELSE 'failed' END,error=?,ended_at=? WHERE id=? AND state!='settled'",
		reason, ended, id)
}

// RecordModuleOperationReceipt records what an operation left behind.
func (k *KernelStore) RecordModuleOperationReceipt(id string, receipt any) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET resource_receipt=? WHERE id=?", receipt, id)
}

// SettleModuleOperation records what an operation published.
func (k *KernelStore) SettleModuleOperation(id, result, digest string, ended int64) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET state='settled',result=?,record_digest=?,ended_at=? WHERE id=?",
		result, digest, ended, id)
}

// DeliverySource is the execution a delivery came from, and where that
// execution stands.
func (k *KernelStore) DeliverySource(deliveryID string) (executionID *string, state string, found bool) {
	row, ok := g5One(k.Db, `SELECT s.execution_id AS execution,e.state AS state FROM kernel_deliveries d
    LEFT JOIN kernel_submissions s ON s.id=d.submission_id LEFT JOIN kernel_executions e ON e.id=s.execution_id
    WHERE d.id=?`, deliveryID)
	if !ok {
		return nil, "", false
	}
	execution := g5Str(row["execution"])
	if execution == "" {
		return nil, g5Str(row["state"]), true
	}
	return &execution, g5Str(row["state"]), true
}
