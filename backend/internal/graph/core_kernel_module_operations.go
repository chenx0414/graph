package graph

type KernelModuleOperation struct {
	Id     string
	State  string
	Result string
}

func (k *KernelStore) ModuleOperationOfDelivery(deliveryID string) *KernelModuleOperation {
	row, ok := g5One(k.Db, "SELECT id,state,result FROM kernel_module_operations WHERE delivery_id=?", deliveryID)
	if !ok {
		return nil
	}
	return &KernelModuleOperation{Id: g5Str(row["id"]), State: g5Str(row["state"]), Result: g5Str(row["result"])}
}

func (k *KernelStore) PrepareModuleOperation(id, taskID, moduleID, deliveryID string, revisionVersion int, request string, created int64) {
	g5Exec(k.Db, `INSERT INTO kernel_module_operations(id,task_id,module_id,delivery_id,revision_version,request,state,created_at)
	VALUES(?,?,?,?,?,?,'prepared',?) ON CONFLICT(delivery_id) DO UPDATE SET request=excluded.request,revision_version=excluded.revision_version,state='prepared',error=NULL,resource_receipt=NULL,record_digest=NULL`,
		id, taskID, moduleID, deliveryID, revisionVersion, request, created)
}

func (k *KernelStore) DispatchModuleOperation(id string) (bool, error) {
	result := kernelExec(k.Db, "UPDATE kernel_module_operations SET state='dispatched',started_at=? WHERE id=? AND state='prepared'", NowMillis(), id)
	count, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return count == 1, nil
}

func (k *KernelStore) ReleaseModuleOperationWorker(id string) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET worker_active=0 WHERE id=?", id)
}

func (k *KernelStore) HoldModuleOperationWorker(id string) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET worker_active=1 WHERE id=?", id)
}

func (k *KernelStore) ModuleOperationPrepared(id string) bool {
	_, ok := g5One(k.Db, "SELECT 1 FROM kernel_module_operations WHERE id=? AND state='prepared'", id)
	return ok
}

func (k *KernelStore) FailModuleOperation(id, reason string, ended int64) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET state=CASE WHEN state='dispatched' THEN 'uncertain' ELSE 'unknown' END,error=?,ended_at=? WHERE id=? AND state!='settled'",
		reason, ended, id)
}

func (k *KernelStore) RecordModuleOperationReceipt(id string, receipt any) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET resource_receipt=? WHERE id=?", receipt, id)
}

func (k *KernelStore) SettleModuleOperation(id, result, digest string, ended int64) {
	g5Exec(k.Db, "UPDATE kernel_module_operations SET state='settled',result=?,record_digest=?,ended_at=? WHERE id=?",
		result, digest, ended, id)
}

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
