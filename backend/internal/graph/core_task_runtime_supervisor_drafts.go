package graph

import "strings"

// ListProjects reads the projects of the runtime.
func (supervisor *TaskRuntimeSupervisor) ListProjects() []map[string]any {
	return supervisor.runtime.User().Projects()
}

// BindProject binds the conversation of the supervisor to a project.
func (supervisor *TaskRuntimeSupervisor) BindProject(projectId, requestId string) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This Main Agent is not attached to a conversation")
	}
	return runtime.Conversations().Bind(conversation.Id, projectId, requestId)
}

// ConfirmDraft confirms one draft on behalf of the user.
func (supervisor *TaskRuntimeSupervisor) ConfirmDraft(input TaskRuntimeConfirmInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	if strings.TrimSpace(input.AttestationInstruction()) == "" {
		Raise("invalid_input", "An instruction is required: record the words that authorised this confirmation")
	}
	instruction := strings.TrimSpace(input.AttestationInstruction())
	authorized := false
	for _, message := range kernelRows(runtime.store.Db, `SELECT m.text FROM messages m
 JOIN conversations c ON c.id=m.conversation_id
 JOIN operations o ON o.id=m.operation_id AND o.task_id=c.anchor_task_id
 WHERE c.anchor_task_id=? AND m.role='user' AND m.kind='chat' AND m.state='delivered'
 AND (m.data IS NULL OR json_extract(m.data,'$.source') IS NULL)
 AND o.state='dispatched' AND o.worker_active=1`, supervisor.taskId) {
		if strings.Contains(kernelString(message["text"]), instruction) {
			authorized = true
			break
		}
	}
	if !authorized {
		Raise("permission", "The confirmation must quote a user message in the current supervisor turn")
	}
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to confirm")
	}
	return runtime.Conversations().Confirm(*conversation, input)
}

// AttestationInstruction reads the recorded instruction of a confirmation.
func (input TaskRuntimeConfirmInput) AttestationInstruction() string {
	if input.Attestation == nil {
		return ""
	}
	return input.Attestation.Instruction
}

