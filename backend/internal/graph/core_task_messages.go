package graph

// The messages table is one message of a conversation: who said it, what
// kind it is, its text and payload, the state it is in, and the operation
// and turn it belongs to.
//
// It was written from two files with SQL of their own, so the shape of the
// table was known in two places. The task store owns it now.

// RecordMessage adds one message to a conversation.
func (s *TaskStore) RecordMessage(conversationID, id, role, kind, text string, data any, state string, operationID *string, turn int, at int64) {
	kernelExec(s.DB, "INSERT INTO messages(conversation_id,id,role,kind,text,data,state,operation_id,turn,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
		conversationID, id, role, kind, text, data, state, operationID, turn, at, at)
}

// SetMessageContent rewrites the content of a message that is already
// there.
func (s *TaskStore) SetMessageContent(conversationID, messageID, text string, data any, state string, operationID *string, turn int, at int64) {
	kernelExec(s.DB, "UPDATE messages SET text=?,data=?,state=?,operation_id=?,turn=?,updated_at=MAX(?,updated_at+1) WHERE id=? AND conversation_id=?",
		text, data, state, operationID, turn, at, messageID, conversationID)
}

// DeliverQueuedMessage says a queued message was delivered, and numbers it
// at the end of the stream.
func (s *TaskStore) DeliverQueuedMessage(messageID string, seq int64, operationID string, turn int, data any, at int64) {
	kernelExec(s.DB, `UPDATE messages SET seq=?,state='delivered',operation_id=?,turn=?,data=COALESCE(?,data),updated_at=MAX(?,updated_at+1)
        WHERE id=? AND state='queued'`, seq, operationID, turn, data, at, messageID)
}

// DeliverPendingMessage says a pending message was delivered.
func (s *TaskStore) DeliverPendingMessage(messageID string, operationID string, turn int, data any, at int64) {
	kernelExec(s.DB, `UPDATE messages SET state='delivered',operation_id=?,turn=?,data=COALESCE(?,data),updated_at=MAX(?,updated_at+1)
        WHERE id=? AND state='pending'`, operationID, turn, data, at, messageID)
}

// ReleaseDeliveredMessages says the messages of one operation are waiting
// for a turn again.
func (s *TaskStore) ReleaseDeliveredMessages(operationID string, at int64) {
	kernelExec(s.DB, "UPDATE messages SET state='pending',operation_id=NULL,updated_at=MAX(?,updated_at+1) WHERE operation_id=? AND state='delivered'", at, operationID)
}

// CancelQueuedMessage says a queued message will not be answered, and
// reports whether it really was still queued.
func (s *TaskStore) CancelQueuedMessage(messageID string, at int64) bool {
	changes := kernelChanges(s.Db, "UPDATE messages SET state='cancelled',updated_at=MAX(?,updated_at+1) WHERE id=? AND state='queued'", at, messageID)
	return changes > 0
}
