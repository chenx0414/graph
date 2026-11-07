package graph

import (
	"fmt"
	"strings"
)

type SupervisorNotice struct {
	Text      string
	Milestone string
	WorkID   string
	Evidence string
	EvidenceExcerpt string
	ArtifactID      string
	ArtifactVersion int
	EvidenceFailure string
	RequestID       string
}

func noticeEvidenceExcerpt(artifactId string, version int, read func(id string, version int, maxBytes int) ArtifactRead) (excerpt string, failure string) {
	if strings.TrimSpace(artifactId) == "" {
		return "", ""
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			excerpt = ""
			_, code, message, _ := PublicError(recovered)
			failure = code + ": " + message
		}
	}()
	result := read(artifactId, version, 1_500)
	if result.Text == nil {
		return "", "the artifact holds no text"
	}
	text := strings.TrimSpace(*result.Text)
	if result.Truncated {
		text += fmt.Sprintf("\n…（已截到 %d 字节，完整内容见 artifact %s）", result.Bytes, artifactId)
	}
	return text, ""
}

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
				reason := strings.TrimSpace(notice.EvidenceFailure)
				if reason == "" {
					reason = "发送方没能读出它"
				}
				body += "\n证据附件: " + notice.ArtifactID + " 未附加——" + reason + "。请向项目侧要求可读的摘要或路径。"
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
		RecoverMaster(store, anchor, "message")
		store.Event(taskID, "supervisor.notice", map[string]any{"conversationId": globalID, "messageId": message.Id, "milestone": milestone, "workId": workID})
		return map[string]any{"delivered": true, "conversationId": globalID, "messageId": message.Id, "milestone": milestone, "workId": workID}
	})
}
