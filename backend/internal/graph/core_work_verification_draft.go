package graph

import (
	"fmt"
	"strings"
)

func (runtime *TaskRuntime) publishVerificationDraft(work WorkRecord, draft WorkDraft, definition GraphDefinition) {
	branch := ""
	if work.ProjectID != nil {
		if prepared := runtime.git.Preparation(*work.ProjectID); prepared != nil && prepared.Branch != nil {
			branch = *prepared.Branch
		} else if project := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", *work.ProjectID); project != nil {
			if current := CheckedOutBranch(kernelString(project["root"])); current != nil {
				branch = *current
			}
		}
	}
	checks := []string{}
	for _, item := range definition.Acceptance {
		line := item.Description
		if item.Verification != nil {
			operation := definition.Modules[item.Module].Operation
			line += fmt.Sprintf("\n%s %s\n验证文件 %s\n预期失败包含「%s」", operation.Command, strings.Join(operation.Args, " "),
				strings.Join(item.Verification.Paths, "、"), item.Verification.FailureText)
		}
		checks = append(checks, line)
	}
	AppendMessage(runtime.store, MessageInput{
		ConversationID: work.ConversationID, Role: MessageRoleSystem, Kind: "verification_draft",
		Text: g5Str(draft.Proposal["summary"]),
		Data: map[string]any{"verificationDraft": map[string]any{
			"workId": work.ID, "workRevision": draft.WorkRevision, "version": draft.Version,
			"draftRevision": draft.DraftRevision, "targetBranch": branch, "checks": checks,
		}},
	})
}

func markVerificationDraftConfirmed(store *TaskStore, reservation WorkGraph) {
	row := kernelRow(store.Db, `SELECT id, conversation_id, text, data FROM messages
 WHERE role='system' AND kind='verification_draft' AND json_extract(data,'$.verificationDraft.workId')=?
 AND json_extract(data,'$.verificationDraft.version')=? AND json_extract(data,'$.verificationDraft.draftRevision')=?
 ORDER BY seq DESC LIMIT 1`, reservation.WorkID, reservation.Version, reservation.DraftRevision)
	if row == nil {
		return
	}
	data, _ := g5JSON(kernelString(row["data"])).(map[string]any)
	draft, _ := data["verificationDraft"].(map[string]any)
	draft["confirmed"] = true
	id := kernelString(row["id"])
	AppendMessage(store, MessageInput{
		MessageID: &id, ConversationID: kernelString(row["conversation_id"]),
		Role: MessageRoleSystem, Kind: "verification_draft", Text: kernelString(row["text"]), Data: data,
	})
}
