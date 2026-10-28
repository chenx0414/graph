package graph

func (s *TaskStore) AssignConversationRole(conversationID string, role ConversationRole) {
	kernelExec(s.DB, "UPDATE conversations SET role=? WHERE id=?", string(role), conversationID)
}

// CreateConversation opens one conversation.
func (s *TaskStore) CreateConversation(id string, projectID *string, workspaceProjectID, anchorTaskID, title string, sequence, createdAt int64) {
	kernelExec(s.DB, "INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES(?,?,?,?,?,?,?)",
		id, projectID, workspaceProjectID, anchorTaskID, title, sequence, createdAt)
}

// ArchiveConversation puts a conversation away.
func (s *TaskStore) ArchiveConversation(conversationID string, at int64) {
	kernelExec(s.DB, "UPDATE conversations SET archived_at=? WHERE id=?", at, conversationID)
}

// RestoreConversation brings an archived conversation back.
func (s *TaskStore) RestoreConversation(conversationID string) {
	kernelExec(s.DB, "UPDATE conversations SET archived_at=NULL WHERE id=?", conversationID)
}

// BindConversationProject says which project a conversation belongs to.
func (s *TaskStore) BindConversationProject(conversationID, projectID string) {
	kernelExec(s.DB, "UPDATE conversations SET project_id=? WHERE id=?", projectID, conversationID)
}

// RebindConversation says the conversation's binding starts from its last
// message, so everything before that was said about the previous project.
func (s *TaskStore) RebindConversation(conversationID string) {
	kernelExec(s.DB, "UPDATE conversations SET binding_since_seq=COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id=?),0) WHERE id=?", conversationID, conversationID)
}

// SetConversationThinkingLevel says which thinking level a conversation runs
// at.
func (s *TaskStore) SetConversationThinkingLevel(conversationID, level string) {
	kernelExec(s.DB, "UPDATE conversations SET thinking_level=? WHERE id=?", level, conversationID)
}
