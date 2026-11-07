package graph

func (s *TaskStore) RecordMessage(conversationID, id, role, kind, text string, data any, state string, operationID *string, turn int, at int64) {
	kernelExec(s.DB, "INSERT INTO messages(conversation_id,id,role,kind,text,data,state,operation_id,turn,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
		conversationID, id, role, kind, text, data, state, operationID, turn, at, at)
}

func (s *TaskStore) SetMessageContent(conversationID, messageID, text string, data any, state string, operationID *string, turn int, at int64) {
	kernelExec(s.DB, "UPDATE messages SET text=?,data=?,state=?,operation_id=?,turn=?,updated_at=MAX(?,updated_at+1) WHERE id=? AND conversation_id=?",
		text, data, state, operationID, turn, at, messageID, conversationID)
}

func (s *TaskStore) DeliverQueuedMessage(messageID string, seq int64, operationID string, turn int, data any, at int64) {
	kernelExec(s.DB, `UPDATE messages SET seq=?,state='delivered',operation_id=?,turn=?,data=COALESCE(?,data),updated_at=MAX(?,updated_at+1)
        WHERE id=? AND state='queued'`, seq, operationID, turn, data, at, messageID)
}

func (s *TaskStore) DeliverPendingMessage(messageID string, operationID string, turn int, data any, at int64) {
	kernelExec(s.DB, `UPDATE messages SET state='delivered',operation_id=?,turn=?,data=COALESCE(?,data),updated_at=MAX(?,updated_at+1)
        WHERE id=? AND state='pending'`, operationID, turn, data, at, messageID)
}

func (s *TaskStore) ReleaseDeliveredMessages(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE messages SET state='pending',operation_id=NULL,updated_at=MAX(?,updated_at+1) WHERE operation_id=? AND state='delivered'", at, operationID)
}

func (s *TaskStore) CancelQueuedMessage(messageID string, at int64) bool {
	changes := kernelChanges(s.Db, "UPDATE messages SET state='cancelled',updated_at=MAX(?,updated_at+1) WHERE id=? AND state='queued'", at, messageID)
	return changes > 0
}

func (s *TaskStore) RetireTransferredMessage(messageID string, at int64) {
	kernelExec(s.DB, "UPDATE messages SET state='cancelled',updated_at=MAX(?,updated_at+1) WHERE id=? AND state IN ('pending','queued')", at, messageID)
}
