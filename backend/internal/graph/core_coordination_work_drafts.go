package graph

import "encoding/json"

type WorkDraftInput struct {
	WorkRevision          int64          `json:"workRevision"`
	ExpectedDraftRevision *int64         `json:"expectedDraftRevision,omitempty"`
	NewVersion            bool           `json:"newVersion"`
	Proposal              map[string]any `json:"proposal"`
}

type WorkDraftAction struct {
	Version               int64  `json:"version"`
	ExpectedDraftRevision int64  `json:"expectedDraftRevision"`
	Action                string `json:"action"`
}

func (runtime *TaskRuntime) PutWorkDraft(workID string, input WorkDraftInput, requestID string) WorkDraft {
	runtime.ensureOpen()
	ValidateProposal(input.Proposal)
	if !jsSafeInteger(input.Proposal["requirementVersion"]) || int64(numberValue(input.Proposal["requirementVersion"])) != input.WorkRevision {
		Raise("stale_work", "The proposal must name the same work revision")
	}
	result := runtime.store.Command("work:draft:"+workID, requestID, input, func() any {
		work := runtime.store.workInTransaction(workID)
		if work.Revision != input.WorkRevision || (work.State != "clarifying" && work.State != "ready" && work.State != "dispatched") {
			Raise("stale_work", "The work changed or is not accepting a draft")
		}
		spec := CanonicalJSON(input.Proposal)
		digest := ContentDigest(spec)
		current := kernelRow(runtime.store.Db, `SELECT version,work_revision,draft_revision FROM work_drafts
 WHERE work_id=? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`, workID)
		version := int64(1)
		high := kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(version),0) AS version FROM work_drafts WHERE work_id=?", workID)
		version = kernelInt(high["version"]) + 1
		if current != nil && !input.NewVersion && kernelInt(current["work_revision"]) == work.Revision {
			if input.ExpectedDraftRevision == nil {
				Raise("stale_draft", "A current draft revision is required to edit the draft")
			}
			version = kernelInt(current["version"])
			runtime.store.updateWorkDraft(workID, version, *input.ExpectedDraftRevision, spec, digest, NowMillis())
		} else {
			if input.ExpectedDraftRevision != nil {
				Raise("stale_draft", "This draft is no longer current; read it again")
			}
			runtime.store.insertWorkDraft(workID, version, work.Revision, spec, digest, NowMillis())
		}
		conversation := ConversationRowOf(runtime.store, work.ConversationID)
		draft := runtime.store.workDraftInTransaction(workID, version, false)
		runtime.store.Event(conversation.AnchorTaskId, "work.draft.saved", map[string]any{"workId": workID, "version": version})
		if conversation.Role == ConversationGlobal {
			WakeMaster(runtime.store, WakeIntent{TaskID: conversation.AnchorTaskId, Kind: "work_draft_ready",
				DedupeKey: workID + ":" + itoa(int(version)) + ":" + itoa(int(draft.DraftRevision)),
				Data:      map[string]any{"workId": workID, "version": version, "workRevision": draft.WorkRevision, "draftRevision": draft.DraftRevision, "projectId": work.ProjectID}, HasData: true})
		}
		return draft
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return workDraftReceipt(result)
}

func (runtime *TaskRuntime) ChangeWorkDraft(workID string, input WorkDraftAction, requestID string) WorkDraft {
	runtime.ensureOpen()
	result := runtime.store.Command("work:draft-action:"+workID, requestID, input, func() any {
		work := runtime.store.workInTransaction(workID)
		runtime.store.setWorkDraftState(workID, input.Version, input.ExpectedDraftRevision, input.Action, NowMillis())
		conversation := ConversationRowOf(runtime.store, work.ConversationID)
		runtime.store.Event(conversation.AnchorTaskId, "work.draft."+input.Action, map[string]any{"workId": workID, "version": input.Version})
		return runtime.store.workDraftInTransaction(workID, input.Version, true)
	})
	return workDraftReceipt(result)
}

func workDraftReceipt(value any) WorkDraft {
	if draft, ok := value.(WorkDraft); ok {
		return draft
	}
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var draft WorkDraft
	if err := json.Unmarshal(data, &draft); err != nil {
		panic(err)
	}
	return draft
}

type WorkDraftToolInput struct {
	WorkID    string
	RequestID string
	Draft     WorkDraftInput
}

func (runtime *TaskRuntime) ProposeWorkGraph(taskID string, input WorkDraftToolInput) WorkDraft {
	conversation := ConversationForTask(runtime.store, taskID)
	if conversation == nil || conversation.Role != ConversationProject || conversation.AnchorTaskId != taskID || conversation.ProjectId == nil {
		Raise("permission", "Only the responsible project supervisor may draft this work")
	}
	work := runtime.store.Work(input.WorkID)
	if work.ProjectID == nil || *work.ProjectID != *conversation.ProjectId {
		Raise("permission", "The work belongs to another project")
	}
	return runtime.PutWorkDraft(input.WorkID, input.Draft, input.RequestID)
}

func (runtime *TaskRuntime) ReadWorkDraft(taskID, workID string, version int64) WorkDraft {
	conversation := ConversationForTask(runtime.store, taskID)
	if conversation == nil || conversation.AnchorTaskId != taskID {
		Raise("permission", "A supervisor thread is required")
	}
	work := runtime.store.Work(workID)
	if conversation.Role == ConversationGlobal && work.ConversationID != conversation.Id {
		Raise("permission", "This work belongs to another supervisor")
	}
	if conversation.Role == ConversationProject && (conversation.ProjectId == nil || work.ProjectID == nil || *conversation.ProjectId != *work.ProjectID) {
		Raise("permission", "This work belongs to another project")
	}
	if conversation.Role != ConversationGlobal && conversation.Role != ConversationProject {
		Raise("permission", "A supervisor thread is required")
	}
	return runtime.store.WorkDraft(workID, version)
}
