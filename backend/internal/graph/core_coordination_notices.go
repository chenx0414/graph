package graph

import "strings"

// SupervisorNotice is what a project supervisor tells the global supervisor
// without asking anything back.
//
// A question opens a decision and stops the asking turn until it is answered. A
// notice is the other half of that channel: the project says what happened and
// keeps working, and the global supervisor's thread receives a message it can
// accept from.
type SupervisorNotice struct {
	Text      string
	Milestone string
	Evidence  string
	RequestID string
}

// RecordSupervisorNotice delivers one notice into the global conversation and
// wakes its master.
//
// The notice is not a question: no question row opens, nothing waits for an
// answer, and the sender's turn continues. The request id makes the delivery
// idempotent, so a retried tool call does not wake the global supervisor twice.
func RecordSupervisorNotice(store *TaskStore, taskID string, notice SupervisorNotice) any {
	caller := ConversationForTask(store, taskID)
	if caller == nil || caller.Role != ConversationProject {
		Raise("permission", "Only a project supervisor can notify the global supervisor")
	}
	text := strings.TrimSpace(notice.Text)
	if text == "" {
		Raise("invalid_input", "A notice needs its text")
	}
	requestID := strings.TrimSpace(notice.RequestID)
	if requestID == "" || len(requestID) > 200 {
		Raise("invalid_input", "A bounded requestId is required")
	}
	global := kernelRow(store.Db, "SELECT id,anchor_task_id FROM conversations WHERE role='global' AND archived_at IS NULL")
	if global == nil {
		Raise("invalid_state", "The global supervisor is unavailable")
	}
	globalID, anchor := kernelString(global["id"]), kernelString(global["anchor_task_id"])
	projectID := ""
	if caller.ProjectId != nil {
		projectID = *caller.ProjectId
	}
	milestone := strings.TrimSpace(notice.Milestone)
	if milestone == "" {
		milestone = "update"
	}
	evidence := strings.TrimSpace(notice.Evidence)
	return store.Command("supervisor:notice:"+taskID, requestID, map[string]any{
		"text": text, "milestone": milestone, "evidence": evidence, "projectId": projectID,
	}, func() any {
		body := "[来自项目主管的通知]\n项目: " + projectID + "\n里程碑: " + milestone + "\n内容: " + text
		if evidence != "" {
			body += "\n证据: " + evidence
		}
		body += "\n这条通知不需要回答；需要验收时先读工作草案与验收证据，再决定下一步。"
		message := AppendMessage(store, MessageInput{
			ConversationID: globalID, Role: MessageRoleUser, Kind: "chat", Text: body, State: MessageStatePending,
			Data: map[string]any{"source": map[string]any{"kind": "agent", "conversationId": caller.Id, "taskId": taskID}, "milestone": milestone},
		})
		WakeMaster(store, WakeIntent{
			TaskID: anchor, Kind: "supervisor_notice", DedupeKey: taskID + ":" + milestone + ":" + requestID,
			Data: map[string]any{"conversationId": caller.Id, "taskId": taskID, "milestone": milestone}, HasData: true,
		})
		store.Event(taskID, "supervisor.notice", map[string]any{"conversationId": globalID, "messageId": message.Id, "milestone": milestone})
		return map[string]any{"delivered": true, "conversationId": globalID, "messageId": message.Id, "milestone": milestone}
	})
}
