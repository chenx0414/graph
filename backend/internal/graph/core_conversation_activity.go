package graph

import (
	"strings"
)

// PublishConversationDelta persists one appendable live response, publishing only the new
// suffix in the common case. A reset carries the full active text so a reconnect can
// repair any missing prefix without guessing.
func PublishConversationDelta(store *TaskStore, input PiAdapterConversationDelta) {
	previous := kernelRow(store.Db, "SELECT * FROM conversation_streams WHERE operation_id=? AND entry_id=? AND part_id=?",
		input.OperationId, input.EntryId, input.PartId)
	appendable := false
	if previous != nil {
		// The caller writes the length of a text part in the same unit the
		// TypeScript string length used, so the delta is counted the same way.
		appendable = strings.HasPrefix(input.Text, kernelString(previous["text"])) &&
			int(kernelInt(previous["length"]))+utf16Len(input.Delta) == input.Length
	}
	reset := !appendable
	text := input.Text
	if !reset {
		text = input.Delta
	}
	store.Transaction(func() any {
		kernelExec(store.Db, `INSERT INTO conversation_streams(
      operation_id,conversation_id,entry_id,part_id,ordinal,text,length,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(operation_id,entry_id,part_id) DO UPDATE SET
      conversation_id=excluded.conversation_id,
      ordinal=excluded.ordinal,
      text=excluded.text,
      length=excluded.length,
      updated_at=excluded.updated_at`,
			input.OperationId, input.ConversationId, input.EntryId, input.PartId,
			input.Ordinal, input.Text, input.Length, NowMillis())
		store.Event(input.TaskId, "message.delta", map[string]any{
			"operationId": input.OperationId,
			"entryId":     input.EntryId,
			"partId":      input.PartId,
			"ordinal":     input.Ordinal,
			"text":        text,
			"len":         input.Length,
			"reset":       reset,
		})
		return nil
	})
}

// ClearConversationStream drops the live text parts of one operation.
func ClearConversationStream(store *TaskStore, operationId string) {
	kernelExec(store.Db, "DELETE FROM conversation_streams WHERE operation_id=?", operationId)
}

// ConversationStreams lists the live text parts of the operations that are still running.
func ConversationStreams(store *TaskStore, conversationId string) []ConversationStream {
	rows := kernelRows(store.Db, `SELECT s.* FROM conversation_streams s
    JOIN operations o ON o.id=s.operation_id
    WHERE s.conversation_id=? AND o.state IN ('intent','dispatched')
    ORDER BY s.ordinal, s.updated_at`, conversationId)
	streams := make([]ConversationStream, 0, len(rows))
	for _, row := range rows {
		streams = append(streams, ConversationStream{
			OperationId: kernelString(row["operation_id"]),
			EntryId:     kernelString(row["entry_id"]),
			PartId:      kernelString(row["part_id"]),
			Ordinal:     int(kernelInt(row["ordinal"])),
			Text:        kernelString(row["text"]),
			Length:      int(kernelInt(row["length"])),
			UpdatedAt:   kernelInt(row["updated_at"]),
		})
	}
	return streams
}
