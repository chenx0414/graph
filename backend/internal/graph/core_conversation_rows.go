package graph

import (
	"encoding/json"
)

func ConversationRowOf(store *TaskStore, conversationId string) ConversationRow {
	row := kernelRow(store.Db, "SELECT * FROM conversations WHERE id=?", conversationId)
	if row == nil {
		Raise("not_found", "Conversation not found")
	}
	return ConversationRow{
		Id:                 kernelString(row["id"]),
		Role:               ConversationRole(kernelString(row["role"])),
		ProjectId:          conversationNullableString(row["project_id"]),
		WorkspaceProjectId: kernelString(row["workspace_project_id"]),
		AnchorTaskId:       kernelString(row["anchor_task_id"]),
		Title:              kernelString(row["title"]),
		CreatedSeq:         kernelInt(row["created_seq"]),
		CreatedAt:          kernelInt(row["created_at"]),
		ArchivedAt:         conversationNullableInt(row["archived_at"]),
		ThinkingLevel:      conversationNullableString(row["thinking_level"]),
		BindingSinceSeq:    kernelInt(row["binding_since_seq"]),
	}
}

func ConversationForTask(store *TaskStore, taskId string) *ConversationRow {
	row := kernelRow(store.Db, "SELECT c.* FROM conversations c JOIN tasks t ON t.conversation_id=c.id WHERE t.id=?", taskId)
	if row == nil {
		return nil
	}
	return &ConversationRow{
		Id:                 kernelString(row["id"]),
		Role:               ConversationRole(kernelString(row["role"])),
		ProjectId:          conversationNullableString(row["project_id"]),
		WorkspaceProjectId: kernelString(row["workspace_project_id"]),
		AnchorTaskId:       kernelString(row["anchor_task_id"]),
		Title:              kernelString(row["title"]),
		CreatedSeq:         kernelInt(row["created_seq"]),
		CreatedAt:          kernelInt(row["created_at"]),
		ArchivedAt:         conversationNullableInt(row["archived_at"]),
		ThinkingLevel:      conversationNullableString(row["thinking_level"]),
		BindingSinceSeq:    kernelInt(row["binding_since_seq"]),
	}
}

func SupervisorConversationForTask(store *TaskStore, taskID string) *ConversationRow {
	anchor, ok := questionConversationAnchor(store, taskID)
	if !ok {
		return nil
	}
	return ConversationForTask(store, anchor)
}

func PublicMessage(row MessageRow) ConversationMessage {
	message := ConversationMessage{
		Id:          row.Id,
		Seq:         int(row.Seq),
		Role:        row.Role,
		Kind:        row.Kind,
		Text:        row.Text,
		State:       row.State,
		OperationId: row.OperationId,
		Turn:        int(row.Turn),
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
	}
	if row.Data != nil && *row.Data != "" {
		var parsed any
		if err := json.Unmarshal([]byte(*row.Data), &parsed); err != nil {
			panic(err)
		}
		if record, ok := StripAttachmentData(parsed).(map[string]any); ok {
			message.Data = record
		}
	}
	return message
}
