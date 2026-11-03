package graph

import (
	"strings"
)

// List reads the conversation list.
func (conversations *TaskRuntimeConversations) List(archived bool) []map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	filter := "IS NULL"
	if archived {
		filter = "IS NOT NULL"
	}
	rows := kernelRows(runtime.store.Db, `SELECT c.id,c.role,c.title,c.project_id AS projectId,c.anchor_task_id AS anchorTaskId,c.created_at AS createdAt,
    c.archived_at AS archivedAt,
    (SELECT MAX(e.timestamp) FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.conversation_id=c.id) AS updatedAt,
    (SELECT COUNT(*) FROM questions q JOIN tasks t ON t.id=q.task_id WHERE t.conversation_id=c.id AND q.status='open' AND q.owner='user') AS openQuestions,
    (SELECT COUNT(*) FROM questions q JOIN tasks t ON t.id=q.task_id WHERE t.conversation_id=c.id AND q.status='open' AND q.owner='user' AND q.asked_at IS NOT NULL AND q.asked_at<=?) AS suspendedQuestions,
    (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id=c.id AND t.phase!='chatting') AS taskCount
    FROM conversations c WHERE c.archived_at `+filter+`
    ORDER BY c.created_seq`, NowMillis()-QuestionSuspendedMs)
	out := []map[string]any{}
	for _, row := range rows {
		status := "chatting"
		switch {
		case kernelInt(row["suspendedQuestions"]) > 0:
			status = QuestionWaitStatus
		case kernelInt(row["openQuestions"]) > 0:
			status = "blocked"
		case kernelInt(row["taskCount"]) > 0:
			status = "executing"
		}
		out = append(out, map[string]any{
			"id":                 kernelString(row["id"]),
			"role":               kernelString(row["role"]),
			"title":              kernelString(row["title"]),
			"projectId":          row["projectId"],
			"anchorTaskId":       kernelString(row["anchorTaskId"]),
			"createdAt":          kernelInt(row["createdAt"]),
			"archivedAt":         row["archivedAt"],
			"updatedAt":          row["updatedAt"],
			"openQuestions":      kernelInt(row["openQuestions"]),
			"suspendedQuestions": kernelInt(row["suspendedQuestions"]),
			"taskCount":          kernelInt(row["taskCount"]),
			"status":             status,
		})
	}
	return out
}

// Archive archives one conversation.
func (conversations *TaskRuntimeConversations) Archive(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	if conversation.Role == ConversationGlobal || conversation.Role == ConversationProject {
		Raise("invalid_input", "A supervisor thread cannot be archived as a conversation")
	}
	result := runtime.store.Command("conversation:"+conversationId, requestId, map[string]any{"type": "archive"}, func() any {
		now := NowMillis()
		if conversation.ArchivedAt == nil {
			runtime.store.ArchiveConversation(conversationId, now)
		}
		archivedAt := now
		if conversation.ArchivedAt != nil {
			archivedAt = *conversation.ArchivedAt
		}
		return map[string]any{
			"conversationId": conversationId,
			"archived":       true,
			"archivedAt":     archivedAt,
			"cursor":         runtime.store.Event(conversation.AnchorTaskId, "conversation.archived", map[string]any{"conversationId": conversationId}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// Unarchive restores one archived conversation.
func (conversations *TaskRuntimeConversations) Unarchive(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	result := runtime.store.Command("conversation:"+conversationId, requestId, map[string]any{"type": "unarchive"}, func() any {
		if conversation.ArchivedAt != nil {
			runtime.store.RestoreConversation(conversationId)
		}
		return map[string]any{
			"conversationId": conversationId,
			"archived":       false,
			"archivedAt":     nil,
			"cursor":         runtime.store.Event(conversation.AnchorTaskId, "conversation.unarchived", map[string]any{"conversationId": conversationId}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// TaskRuntimeChatInput is one user message of a conversation.
type TaskRuntimeChatInput struct {
	Text        string
	RequestId   string
	Attachments []AttachmentInput
	Command     *string
	Source      Json
}

// Chat adds one user message to a conversation.
func (conversations *TaskRuntimeConversations) Chat(conversationId string, input TaskRuntimeChatInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	// /goal is a command, not something the model has to interpret: it acts on
	// the conversation's goal and leaves one visible line.
	if command, ok := ParseGoalCommand(input.Text); ok {
		command.RequestID = input.RequestId
		result := runtime.Conversations().Goal(conversationId, command)
		AppendGoalLine(runtime.store, conversationId, command.Action, result)
		startGoalTurn(conversations, conversationId, command.Action, result, input.RequestId)
		return result
	}
	attachments := CleanAttachments(input.Attachments)
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, map[string]any{
		"type": "chat", "text": input.Text, "attachments": attachments, "command": input.Command, "source": input.Source,
	}, func() any {
		conversation = ConversationRowOf(runtime.store, conversationId)
		if conversation.Role == ConversationHistory {
			Raise("invalid_input", "Historical conversations are read-only")
		}
		if strings.TrimSpace(input.Text) == "" && len(attachments) == 0 && input.Command == nil {
			Raise("invalid_input", "A nonempty message, attachment or command is required")
		}
		// The message is appended before the master is woken. The TypeScript host
		// did both in one synchronous block, so a turn could never start before the
		// message it has to answer existed. The Go host runs the command and the
		// dispatch on separate goroutines, so the message comes first. The state
		// reads the same status either way: recovering the master only moves a node
		// that was not busy, and a node that is not busy is pending in both readings.
		node := kernelRow(runtime.store.Db, "SELECT status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'", conversation.AnchorTaskId)
		anchor := runtime.store.Task(conversation.AnchorTaskId)
		state := "pending"
		if anchor.Paused != 0 || (node != nil && (kernelString(node["status"]) == "preparing" || kernelString(node["status"]) == "running" || kernelString(node["status"]) == "blocked")) {
			state = "queued"
		}
		data := any(nil)
		extra := map[string]any{}
		if len(attachments) > 0 {
			extra["attachments"] = attachments
		}
		if input.Command != nil {
			extra["command"] = *input.Command
		}
		if input.Source != nil {
			extra["source"] = input.Source
		}
		if len(extra) > 0 {
			data = extra
		}
		message := AppendMessage(runtime.store, MessageInput{
			ConversationID: conversationId,
			Role:           MessageRoleUser,
			Kind:           "chat",
			Text:           strings.TrimSpace(input.Text),
			State:          MessageState(state),
			Data:           data,
		})
		RecoverMaster(runtime.store, conversation.AnchorTaskId, "message")
		// A turn that cannot start is told so: the message stays pending, but
		// the user learns why nothing is happening instead of waiting for a
		// reply that cannot come.
		runtime.refuseUndispatchableTurn(conversationId)
		return map[string]any{
			"conversationId": conversationId,
			"messageId":      message.Id,
			"state":          state,
			"cursor":         message.Cursor,
			"pending":        state == "queued",
		}
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// startGoalTurn turns a goal the person just set or resumed into the turn that
// works on it. `set` and `resume` both start work: resuming a paused or
// usage-limited goal says "go on", and a goal that comes back to life without a
// turn sits there until the person speaks again. Pause, extend, done, clear and
// show act on an existing goal, and starting a turn for those would spend model
// calls nobody asked for. The turn is an ordinary message, so it queues behind
// a running turn and is answered in order.
func startGoalTurn(conversations *TaskRuntimeConversations, conversationId, action string, result map[string]any, requestId string) {
	if action != "set" && action != "resume" {
		return
	}
	runtime := conversations.runtime
	if runtime.master == nil || runtime.masterModel() == nil || runtime.masterDefinitionVersion() == nil {
		// No model is configured: the goal is still recorded, and the console
		// says why nothing can start. A message that can never be answered would
		// only look like a lost turn.
		return
	}
	var goal *ConversationGoal
	switch value := result["goal"].(type) {
	case *ConversationGoal:
		goal = value
	case ConversationGoal:
		copied := value
		goal = &copied
	}
	if goal == nil {
		return
	}
	started := conversations.Chat(conversationId, TaskRuntimeChatInput{
		Text:      goalStartInstruction(goal),
		RequestId: requestId + "#goal-start",
		Source:    map[string]any{"kind": "goal_start", "objective": goal.Objective},
	})
	result["started"] = true
	if messageId, ok := started["messageId"]; ok && messageId != nil {
		result["startedMessageId"] = messageId
	}
}

// Compact asks the master to compact the conversation context.
func (conversations *TaskRuntimeConversations) Compact(conversationId, requestId string) map[string]any {
	command := "compact"
	return conversations.Chat(conversationId, TaskRuntimeChatInput{
		Text:      "压缩当前会话上下文",
		RequestId: requestId,
		Command:   &command,
	})
}

// Bind binds one conversation to a project.
func (conversations *TaskRuntimeConversations) Bind(conversationId, projectId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	if conversation.Role == ConversationGlobal || conversation.Role == ConversationProject {
		Raise("invalid_input", "A supervisor thread cannot change its project")
	}
	if kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", projectId) == nil {
		Raise("invalid_input", "A known project is required")
	}
	if !runtime.allowedProjects()[projectId] {
		Raise("invalid_input", "The project is no longer part of the current configuration")
	}
	runtime.git.RequirePrepared(projectId)
	result := runtime.store.Command("conversation:"+conversationId, requestId, map[string]any{"type": "bind", "projectId": projectId}, func() any {
		previous := conversation.ProjectId
		if previous != nil && *previous == projectId {
			return map[string]any{"conversationId": conversationId, "taskId": conversation.AnchorTaskId, "changed": false, "cursor": nil}
		}
		runtime.store.BindConversationProject(conversationId, projectId)
		runtime.store.SetTaskProject(conversation.AnchorTaskId, projectId)
		invalidated := false
		if previous != nil {
			// A draft was investigated against the old project; switching the
			// project makes every existing draft unconfirmable, not just hidden.
			invalidated = true
			runtime.store.BumpRequirementVersion(conversation.AnchorTaskId)
			runtime.store.RebindConversation(conversationId)
			AppendMessage(runtime.store, MessageInput{
				ConversationID: conversationId,
				Role:           MessageRoleSystem,
				Kind:           "project",
				Text:           "项目已从 " + *previous + " 变更为 " + projectId + "；旧草稿失效，请重新调查后生成新草稿。",
				State:          MessageStateDone,
			})
			runtime.store.Event(conversation.AnchorTaskId, "conversation.rebound", map[string]any{"from": *previous, "to": projectId})
		} else {
			AppendMessage(runtime.store, MessageInput{
				ConversationID: conversationId,
				Role:           MessageRoleSystem,
				Kind:           "project",
				Text:           "已绑定项目 " + projectId,
				State:          MessageStateDone,
			})
		}
		return map[string]any{
			"conversationId":    conversationId,
			"taskId":            conversation.AnchorTaskId,
			"changed":           true,
			"invalidatedDrafts": invalidated,
			"cursor":            runtime.store.Event(conversation.AnchorTaskId, "conversation.bound", map[string]any{"projectId": projectId, "previous": previous}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// TaskRuntimeConfirmInput confirms one draft of a conversation.
type TaskRuntimeConfirmInput struct {
	ProposalVersion int
	DraftRevision   int
	TargetBranch    string
	RequestId       string
	Attestation     *TaskRuntimeAttestation
}

// TaskRuntimeAttestation records who authorised a confirmation.
type TaskRuntimeAttestation struct {
	Actor       string
	OnBehalfOf  string
	Instruction string
}
