package graph

import "strings"

func (supervisor *TaskRuntimeSupervisor) ListProjects() []map[string]any {
	projects := supervisor.runtime.User().Projects()
	active := make([]map[string]any, 0, len(projects))
	for _, project := range projects {
		if project["archivedAt"] == nil {
			active = append(active, project)
		}
	}
	return active
}

func (supervisor *TaskRuntimeSupervisor) BindProject(projectId, requestId string) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This Main Agent is not attached to a conversation")
	}
	return runtime.Conversations().Bind(conversation.Id, projectId, requestId)
}

func (supervisor *TaskRuntimeSupervisor) ConfirmDraft(input TaskRuntimeConfirmInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	if strings.TrimSpace(input.AttestationInstruction()) == "" {
		Raise("invalid_input", "An instruction is required: record the words that authorised this confirmation")
	}
	instruction := strings.TrimSpace(input.AttestationInstruction())
	if !confirmationQuoted(runtime.store, supervisor.taskId, instruction) {
		Raise("permission", "The confirmation must quote a message recorded in this conversation")
	}
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to confirm")
	}
	return runtime.Conversations().Confirm(*conversation, input)
}

func confirmationQuoted(store *TaskStore, anchorTaskId, instruction string) bool {
	instruction = strings.TrimSpace(instruction)
	if instruction == "" || strings.TrimSpace(anchorTaskId) == "" {
		return false
	}
	row := kernelRow(store.Db, `SELECT COUNT(*) AS count FROM messages m
 JOIN conversations c ON c.id=m.conversation_id
 WHERE c.anchor_task_id=? AND m.role='user' AND m.kind='chat' AND instr(m.text, ?)>0`, anchorTaskId, instruction)
	return row != nil && kernelInt(row["count"]) > 0
}

func (input TaskRuntimeConfirmInput) AttestationInstruction() string {
	if input.Attestation == nil {
		return ""
	}
	return input.Attestation.Instruction
}
