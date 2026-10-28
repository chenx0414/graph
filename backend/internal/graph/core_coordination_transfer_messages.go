package graph

// TransferLegacyPendingMessages preserves source order and records each handoff
// as a peer message, never as a fresh user instruction.
func TransferLegacyPendingMessages(store *TaskStore, source, destination string) map[string]string {
	moved := map[string]string{}
	rows := kernelRows(store.Db, "SELECT id,role,kind,text,data FROM messages WHERE conversation_id=? AND kind IN ('peer','chat') AND state IN ('pending','queued') ORDER BY seq", source)
	for _, row := range rows {
		data := map[string]any{}
		if row["data"] != nil {
			parsed := asMap(parseJSON(kernelString(row["data"])))
			if parsed == nil {
				Raise("migration_in_progress", "A pending message has unsupported metadata")
			}
			data = parsed
		}
		kind := kernelString(row["kind"])
		if kind == "peer" {
			graphID := mapString(data, "graphId")
			if kernelString(row["role"]) != "user" || graphID == "" || kernelRow(store.Db, "SELECT id FROM tasks WHERE id=? AND conversation_id=? AND phase!='chatting'", graphID, source) == nil {
				Raise("migration_in_progress", "A pending peer message cannot yet be transferred safely")
			}
		}
		oldID := kernelString(row["id"])
		data["sourceConversationId"] = source
		data["sourceMessageId"] = oldID
		text := kernelString(row["text"])
		if kind == "chat" {
			text = "[Historical conversation handoff: " + source + ", message " + oldID + "]\nRead the source conversation for context. This is a previously queued message, not a new user instruction:\n\n" + text
		}
		copy := AppendMessage(store, MessageInput{ConversationID: destination, Role: MessageRoleUser, Kind: "peer", Text: text, State: MessageStatePending, Data: data})
		if kind == "peer" {
			moved[oldID] = copy.Id
		}
		store.RetireTransferredMessage(oldID, NowMillis())
		PublishMessageUpdate(store, oldID)
	}
	if len(rows) > 0 {
		RecoverMaster(store, ConversationRowOf(store, destination).AnchorTaskId, "message")
	}
	return moved
}
