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
	// WorkID is the work the milestone belongs to. With it the notice is
	// delivered once per work and milestone, however many tool calls say it
	// again; without it the request id is the only identity there is.
	WorkID    string
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
	workID := strings.TrimSpace(notice.WorkID)
	// One delivery per work and milestone: the scope key of the command is what
	// makes a repeated notice a no-op instead of a second message and a second
	// wake. Without a work id the call's own request id is the identity.
	delivery := "notice:" + requestID
	if workID != "" {
		delivery = workID + ":" + milestone
	}
	return store.Command("supervisor:notice:"+taskID, delivery, map[string]any{
		"text": text, "milestone": milestone, "workId": workID, "evidence": evidence, "projectId": projectID,
	}, func() any {
		body := "[来自项目主管的通知]\n项目: " + projectID
		if workID != "" {
			body += "\n工作: " + workID
		}
		body += "\n里程碑: " + milestone + "\n内容: " + text
		if evidence != "" {
			body += "\n证据: " + evidence
		}
		body += "\n这条通知不需要回答；需要验收时先读工作草案与验收证据，再决定下一步。"
		message := AppendMessage(store, MessageInput{
			ConversationID: globalID, Role: MessageRoleUser, Kind: "chat", Text: body, State: MessageStatePending,
			Data: map[string]any{"source": map[string]any{"kind": "agent", "conversationId": caller.Id, "taskId": taskID}, "milestone": milestone, "workId": workID},
		})
		WakeMaster(store, WakeIntent{
			TaskID: anchor, Kind: "supervisor_notice", DedupeKey: taskID + ":" + delivery,
			Data: map[string]any{"conversationId": caller.Id, "taskId": taskID, "milestone": milestone, "workId": workID}, HasData: true,
		})
		store.Event(taskID, "supervisor.notice", map[string]any{"conversationId": globalID, "messageId": message.Id, "milestone": milestone, "workId": workID})
		return map[string]any{"delivered": true, "conversationId": globalID, "messageId": message.Id, "milestone": milestone, "workId": workID}
	})
}
