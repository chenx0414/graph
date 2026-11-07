package graph

func AppendMessage(store *TaskStore, input MessageInput) AppendedMessage {
	now := NowMillis()
	operationId := ""
	if input.OperationID != nil {
		operationId = *input.OperationID
	}
	if operationId != "" && input.Role == MessageRoleAssistant {
		ClearConversationStream(store, operationId)
	}
	state := string(input.State)
	if state == "" {
		state = string(MessageStateDone)
	}
	var data any
	if input.Data != nil {
		data = CanonicalJSON(input.Data)
	}
	if input.MessageID != nil && *input.MessageID != "" {
		store.SetMessageContent(input.ConversationID, *input.MessageID, input.Text, data, state, input.OperationID, input.Turn, now)
		row, ok := conversationMessageRow(store, *input.MessageID)
		if !ok {
			Raise("not_found", "Message not found")
		}
		anchor := ConversationRowOf(store, input.ConversationID).AnchorTaskId
		store.Event(anchor, "message.updated", map[string]any{"message": PublicMessage(row)})
		return AppendedMessage{ConversationMessage: PublicMessage(row)}
	}
	id := newUUID()
	store.RecordMessage(input.ConversationID, id, string(input.Role), input.Kind, input.Text, data, state, input.OperationID, input.Turn, now)
	row, ok := conversationMessageRow(store, id)
	if !ok {
		Raise("not_found", "Message not found")
	}
	anchor := ConversationRowOf(store, input.ConversationID).AnchorTaskId
	cursor := store.Event(anchor, "message.created", map[string]any{"message": PublicMessage(row)})
	return AppendedMessage{ConversationMessage: PublicMessage(row), Cursor: &cursor}
}

func PendingMessages(store *TaskStore, conversationId string, limit int) []MessageRow {
	if limit <= 0 {
		limit = 50
	}
	rows := kernelRows(store.Db, "SELECT * FROM messages WHERE conversation_id=? AND state IN ('pending','queued') ORDER BY seq LIMIT ?", conversationId, limit)
	return conversationMessageRows(rows)
}

func DeliverMessages(store *TaskStore, operationId string, turn int, messages []MessageRow, ordinal ...int) {
	hasOrdinal := len(ordinal) > 0
	for _, message := range messages {
		var rowData any
		if hasOrdinal {
			rowData = conversationOrdinalData(message, ordinal[0])
		}
		if message.State == string(MessageStateQueued) {
			next := int(kernelInt(kernelRow(store.Db, "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages")["seq"]))
			store.DeliverQueuedMessage(message.Id, int64(next), operationId, turn, rowData, NowMillis())
			kernelExec(store.Db, "UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='messages'", next)
		} else {
			store.DeliverPendingMessage(message.Id, operationId, turn, rowData, NowMillis())
		}
		PublishMessageUpdate(store, message.Id)
	}
}

func MessagesForOperation(store *TaskStore, operationId string) []MessageRow {
	rows := kernelRows(store.Db, "SELECT * FROM messages WHERE operation_id=? ORDER BY seq", operationId)
	return conversationMessageRows(rows)
}

func PublishMessageUpdate(store *TaskStore, messageId string) {
	row, ok := conversationMessageRow(store, messageId)
	if !ok {
		return
	}
	anchor := ConversationRowOf(store, row.ConversationId).AnchorTaskId
	store.Event(anchor, "message.updated", map[string]any{"message": PublicMessage(row)})
}

func CancelQueuedMessage(store *TaskStore, conversationId, messageId string) MessageCancellation {
	row := kernelRow(store.Db, "SELECT conversation_id,state FROM messages WHERE id=?", messageId)
	if row == nil || kernelString(row["conversation_id"]) != conversationId {
		return MessageCancellation{State: "missing"}
	}
	state := kernelString(row["state"])
	if state != string(MessageStateQueued) {
		return MessageCancellation{State: state, Cancelled: state == string(MessageStateCancelled)}
	}
	cancelled := store.CancelQueuedMessage(messageId, NowMillis())
	if cancelled {
		PublishMessageUpdate(store, messageId)
	}
	current := kernelRow(store.Db, "SELECT state FROM messages WHERE id=?", messageId)
	currentState := ""
	if current != nil {
		currentState = kernelString(current["state"])
	}
	return MessageCancellation{
		State:     currentState,
		Cancelled: currentState == string(MessageStateCancelled),
		Changed:   cancelled,
	}
}
