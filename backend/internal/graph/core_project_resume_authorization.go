package graph

import "strings"

func requireArchiveResumeInstruction(store *TaskStore, callerTaskID, targetTaskID, sourceID, instruction string) {
	if kernelRow(store.Db, "SELECT task_id FROM project_archive_pauses WHERE task_id=?", targetTaskID) == nil {
		return
	}
	if strings.TrimSpace(sourceID) == "" || strings.TrimSpace(instruction) == "" {
		Raise("permission", "Resuming archived work requires the current user's message and their exact instruction")
	}
	target := store.Task(targetTaskID)
	requireUserResumeInstruction(store, callerTaskID, target.ProjectID, sourceID, instruction)
	store.Event(targetTaskID, "project.resume_authorized", map[string]any{"sourceMessageId": sourceID, "instruction": strings.TrimSpace(instruction), "callerTaskId": callerTaskID})
}

func requireUserResumeInstruction(store *TaskStore, callerTaskID, projectID, sourceID, instruction string) {
	if strings.TrimSpace(sourceID) == "" || strings.TrimSpace(instruction) == "" {
		Raise("permission", "Resuming work requires the current user's message and their exact instruction")
	}
	row := kernelRow(store.Db, `SELECT m.text,m.created_at FROM messages m
 JOIN conversations c ON c.id=m.conversation_id
 JOIN operations o ON o.id=m.operation_id AND o.task_id=c.anchor_task_id
 WHERE m.id=? AND c.anchor_task_id=? AND m.role='user' AND m.kind='chat' AND m.state='delivered'
 AND (m.data IS NULL OR json_extract(m.data,'$.source') IS NULL)
 AND o.state='dispatched' AND o.worker_active=1`, sourceID, callerTaskID)
	if row == nil || !strings.Contains(kernelString(row["text"]), strings.TrimSpace(instruction)) {
		Raise("permission", "The resume instruction must quote a user message in the current supervisor turn")
	}
	restore := kernelRow(store.Db, `SELECT timestamp FROM events WHERE type='project.restored'
	 AND json_extract(data,'$.projectId')=? ORDER BY cursor DESC LIMIT 1`, projectID)
	if restore != nil && kernelInt(row["created_at"]) <= kernelInt(restore["timestamp"]) {
		Raise("permission", "The resume instruction must follow the project's restoration")
	}
}
