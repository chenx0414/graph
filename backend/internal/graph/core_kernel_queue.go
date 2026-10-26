package graph

func (k *KernelStore) EnqueueDelivery(taskID, nodeID string, payload any) {
	g5Exec(k.Db, "INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at) VALUES(?,?,?,?,?)", taskID, nodeID, "delivery", k.Content.Encode(payload), NowMillis())
}

// EnqueueInCurrentTransaction appends one queue row for a caller already inside a transaction.
func (k *KernelStore) EnqueueInCurrentTransaction(taskID string, input QueueInsert) QueueRow {
	createdAt := NowMillis()
	_, lastID := g5Exec(k.Db, "INSERT INTO kernel_queue(task_id,node_id,kind,payload,state,created_at) VALUES(?,?,?,?,?,?)", taskID, input.NodeId, input.Kind, k.Content.Encode(input.Payload), "queued", createdAt)
	return QueueRow{Seq: lastID, TaskId: taskID, NodeId: input.NodeId, Kind: input.Kind, Payload: input.Payload, State: "queued", CreatedAt: createdAt}
}

// Enqueue appends one input, joining the current transaction when one is open.
func (k *KernelStore) Enqueue(taskID string, input QueueInsert) QueueRow {
	if k.Store.IsTransaction() {
		return k.EnqueueInCurrentTransaction(taskID, input)
	}
	return k.Store.Transaction(func() any { return k.EnqueueInCurrentTransaction(taskID, input) }).(QueueRow)
}

func (k *KernelStore) historyWindow(query HistoryQuery) (int, int) {
	after := 0
	if query.After != nil {
		after = *query.After
	}
	limit := 100
	if query.Limit != nil {
		limit = *query.Limit
	}
	if !isSafeInteger(after) || after < 0 || !isSafeInteger(limit) || limit < 1 || limit > 200 {
		Raise("invalid_query", "History requires a non-negative after cursor and a limit from 1 to 200")
	}
	return after, limit
}

func (k *KernelStore) queueFrom(row map[string]any) QueueRow {
	var reason *string
	if row["reason"] != nil {
		text := g5Str(row["reason"])
		reason = &text
	}
	return QueueRow{
		Seq: g5Int(row["seq"]), TaskId: g5Str(row["task_id"]), NodeId: g5Str(row["node_id"]), Kind: g5Str(row["kind"]),
		Payload: k.Content.Decode(g5Str(row["payload"])), Generation: g5Int(row["generation"]), Reason: reason, State: g5Str(row["state"]), CreatedAt: g5Int(row["created_at"]),
	}
}

// QueueHistory pages queue rows, including failed inputs.
func (k *KernelStore) QueueHistory(taskID string, query HistoryQuery) QueueHistoryPage {
	after, limit := k.historyWindow(query)
	var node any
	if query.NodeId != nil {
		node = *query.NodeId
	}
	rows := g5Query(k.Db, "SELECT * FROM kernel_queue WHERE task_id=? AND seq>? AND (? IS NULL OR node_id=?) ORDER BY seq LIMIT ?", taskID, after, node, node, limit+1)
	count := limit
	if count > len(rows) {
		count = len(rows)
	}
	items := make([]QueueRow, 0, count)
	for _, row := range rows[:count] {
		items = append(items, k.queueFrom(row))
	}
	var next *int64
	if len(rows) > limit && len(items) > 0 {
		seq := items[len(items)-1].Seq
		next = &seq
	}
	return QueueHistoryPage{Items: items, Next: next}
}

// ExecutionHistory pages frozen execution facts.
func (k *KernelStore) ExecutionHistory(taskID string, query HistoryQuery) ExecutionHistoryPage {
	after, limit := k.historyWindow(query)
	var node any
	if query.NodeId != nil {
		node = *query.NodeId
	}
	rows := g5Query(k.Db, "SELECT rowid AS cursor,id FROM kernel_executions WHERE task_id=? AND rowid>? AND (? IS NULL OR node_id=?) ORDER BY rowid LIMIT ?", taskID, after, node, node, limit+1)
	count := limit
	if count > len(rows) {
		count = len(rows)
	}
	items := []ExecutionHistoryItem{}
	for _, row := range rows[:count] {
		items = append(items, ExecutionHistoryItem{Cursor: g5Int(row["cursor"]), ExecutionRow: *k.Execution(g5Str(row["id"]))})
	}
	var next *int64
	if len(rows) > limit && len(items) > 0 {
		cursor := items[len(items)-1].Cursor
		next = &cursor
	}
	return ExecutionHistoryPage{Items: items, Next: next}
}

// NextQueued is the oldest queued item, or nil.
func (k *KernelStore) NextQueued(taskID, nodeID string) *QueueRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_queue WHERE task_id=? AND node_id=? AND state='queued' ORDER BY seq LIMIT 1", taskID, nodeID)
	if !ok {
		return nil
	}
	queued := k.queueFrom(row)
	return &queued
}

// ClaimQueued marks one queued item claimed.
func (k *KernelStore) ClaimQueued(taskID string, seq int64) *QueueRow {
	return k.Store.Transaction(func() any {
		row, ok := g5One(k.Db, "SELECT * FROM kernel_queue WHERE task_id=? AND seq=?", taskID, seq)
		if !ok {
			Raise("invalid_queue", "Unknown queue item "+kernelItoa(seq))
		}
		if g5Str(row["state"]) != "queued" {
			Raise("invalid_queue", "Queue item "+kernelItoa(seq)+" is "+g5Str(row["state"]))
		}
		g5Exec(k.Db, "UPDATE kernel_queue SET state='claimed' WHERE task_id=? AND seq=?", taskID, seq)
		queued := k.queueFrom(row)
		queued.State = "claimed"
		return &queued
	}).(*QueueRow)
}

// FinishQueued sets a terminal queue state.
func (k *KernelStore) FinishQueued(taskID string, seq int64, state string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state=? WHERE task_id=? AND seq=?", state, taskID, seq)
}

// RequeueFailedItem puts a failed queue item back, with the reason it was
// put back.
func (k *KernelStore) RequeueFailedItem(taskID, nodeID, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='queued',reason=? WHERE task_id=? AND node_id=? AND state='failed'", reason, taskID, nodeID)
}

// FailQueuedItem fails the queue items of a node that will not run again.
func (k *KernelStore) FailQueuedItem(taskID, nodeID, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='failed',reason=? WHERE task_id=? AND node_id=? AND state IN ('queued','claimed')", reason, taskID, nodeID)
}
