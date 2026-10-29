package graph

import (
	"fmt"
	"strings"
)

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
	WorkID   string
	Evidence string
	// EvidenceExcerpt is the artifact body the sender read on the receiver's
	// behalf. The receiver cannot open the sender's task workspace, so a bare
	// pointer is not evidence: it is a claim that cannot be checked.
	EvidenceExcerpt string
	ArtifactID      string
	ArtifactVersion int
	RequestID       string
}

// noticeEvidenceExcerpt reads the named artifact in the sender's own scope and
// returns a bounded excerpt for the delivery.
//
// A missing artifact must not swallow the notice: the receiver still has to hear
// that the milestone happened, and it has to know the evidence did not come
// with it. So a failed read returns an empty excerpt and the notifier says so.
func noticeEvidenceExcerpt(artifactId string, version int, read func(id string, version int, maxBytes int) ArtifactRead) (excerpt string) {
	if strings.TrimSpace(artifactId) == "" {
		return ""
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			excerpt = ""
		}
	}()
	result := read(artifactId, version, 1_500)
	if result.Text == nil {
		return ""
	}
	text := strings.TrimSpace(*result.Text)
	if result.Truncated {
		text += fmt.Sprintf("\n…（已截到 %d 字节，完整内容见 artifact %s）", result.Bytes, artifactId)
	}
	return text
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
		if notice.ArtifactID != "" {
			if strings.TrimSpace(notice.EvidenceExcerpt) == "" {
				body += "\n证据附件: " + notice.ArtifactID + " 未附加——发送方没能读出它，请向项目侧要求可读的摘要或路径。"
			} else {
				body += "\n证据附件: " + notice.ArtifactID
				if notice.ArtifactVersion > 0 {
					body += "@" + itoa(notice.ArtifactVersion)
				}
				body += "\n" + strings.TrimSpace(notice.EvidenceExcerpt)
			}
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
