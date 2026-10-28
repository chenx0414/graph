package graph

type ProjectThreadMigrationSource struct {
	ConversationID string `json:"conversationId"`
	Title          string `json:"title"`
	ActiveGraphs   int64  `json:"activeGraphs"`
	ActiveTurns    int64  `json:"activeTurns"`
	PendingChats   int64  `json:"pendingChats"`
	BlockedChats   int64  `json:"blockedChats"`
	PendingPeers   int64  `json:"pendingPeers"`
	PendingWakes   int64  `json:"pendingWakes"`
	LegacyWork     int64  `json:"legacyWork"`
}

type ProjectThreadMigrationPreview struct {
	ProjectID              string                         `json:"projectId"`
	SelectedConversationID string                         `json:"selectedConversationId"`
	SelectedTitle          string                         `json:"selectedTitle"`
	RestoreSelected        bool                           `json:"restoreSelected"`
	Sources                []ProjectThreadMigrationSource `json:"sources"`
}

func (runtime *TaskRuntime) PreviewProjectThread(projectID, conversationID string) ProjectThreadMigrationPreview {
	runtime.ensureOpen()
	if !runtime.allowedProjects()[projectID] {
		Raise("invalid_input", "A configured project is required")
	}
	selected := ConversationRowOf(runtime.store, conversationID)
	if selected.ProjectId == nil || *selected.ProjectId != projectID || (selected.Role != ConversationLegacy && selected.Role != ConversationProject) {
		Raise("invalid_input", "Select an existing conversation of this project")
	}
	if existing := kernelRow(runtime.store.Db, "SELECT id FROM conversations WHERE role='project' AND project_id=?", projectID); existing != nil && kernelString(existing["id"]) != conversationID {
		Raise("invalid_input", "The project already has a supervisor thread")
	}
	preview := ProjectThreadMigrationPreview{ProjectID: projectID, SelectedConversationID: conversationID, SelectedTitle: selected.Title, RestoreSelected: selected.ArchivedAt != nil, Sources: []ProjectThreadMigrationSource{}}
	rows := kernelRows(runtime.store.Db, `SELECT c.id,c.title,
 (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id=c.id AND t.phase NOT IN ('chatting','completed','stopped','abandoned') AND EXISTS (SELECT 1 FROM kernel_revisions r WHERE r.task_id=t.id)) AS graphs,
 (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id=c.id AND t.phase NOT IN ('chatting','completed','stopped','abandoned') AND NOT EXISTS (SELECT 1 FROM kernel_revisions r WHERE r.task_id=t.id)) AS legacy_work,
 (SELECT COUNT(*) FROM operations o WHERE o.task_id=c.anchor_task_id AND (o.worker_active=1 OR o.state IN ('intent','dispatched','unknown'))) AS active_turns,
 (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.state IN ('pending','queued') AND m.kind!='peer') AS pending_chats,
 (SELECT COUNT(*) FROM messages m JOIN tasks a ON a.id=c.anchor_task_id WHERE m.conversation_id=c.id AND m.state IN ('pending','queued') AND m.kind!='peer' AND (m.kind!='chat' OR m.role!='user' OR a.paused!=0 OR c.archived_at IS NOT NULL)) AS blocked_chats,
 (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.state IN ('pending','queued') AND m.kind='peer') AS pending_peers,
 (SELECT COUNT(*) FROM wake_intents w WHERE w.task_id=c.anchor_task_id AND w.state IN ('waiting','ready')) AS pending_wakes
 FROM conversations c WHERE c.project_id=? AND c.role='legacy' AND c.id!=? ORDER BY c.created_seq`, projectID, conversationID)
	for _, row := range rows {
		preview.Sources = append(preview.Sources, ProjectThreadMigrationSource{ConversationID: kernelString(row["id"]), Title: kernelString(row["title"]), ActiveGraphs: kernelInt(row["graphs"]), ActiveTurns: kernelInt(row["active_turns"]), PendingChats: kernelInt(row["pending_chats"]), BlockedChats: kernelInt(row["blocked_chats"]), PendingPeers: kernelInt(row["pending_peers"]), PendingWakes: kernelInt(row["pending_wakes"]), LegacyWork: kernelInt(row["legacy_work"])})
	}
	return preview
}
