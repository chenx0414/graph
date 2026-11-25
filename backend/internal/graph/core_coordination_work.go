package graph

import (
	"encoding/json"
	"strings"
)

type WorkCreate struct {
	ConversationID  string   `json:"conversationId"`
	ProjectID       string   `json:"projectId"`
	SourceMessageID string   `json:"sourceMessageId"`
	Brief           string   `json:"brief"`
	Acceptance      []string `json:"acceptance"`
}

type WorkEdit struct {
	ExpectedRevision int64    `json:"expectedRevision"`
	ProjectID        *string  `json:"projectId,omitempty"`
	Brief            string   `json:"brief"`
	Acceptance       []string `json:"acceptance"`
}

func normalizeWork(brief string, acceptance []string) (string, []string) {
	brief = strings.TrimSpace(brief)
	if brief == "" {
		Raise("invalid_input", "A work brief is required")
	}
	clean := make([]string, 0, len(acceptance))
	for _, v := range acceptance {
		v = strings.TrimSpace(v)
		if v == "" {
			Raise("invalid_input", "Acceptance items must not be empty")
		}
		clean = append(clean, v)
	}
	return brief, clean
}

func (runtime *TaskRuntime) CreateWork(input WorkCreate, requestID string) WorkRecord {
	runtime.ensureOpen()
	input.Brief, input.Acceptance = normalizeWork(input.Brief, input.Acceptance)
	result := runtime.store.Command("work:create:"+input.ConversationID, requestID, input, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		conversation := ConversationRowOf(runtime.store, input.ConversationID)
		if conversation.Role != ConversationGlobal && conversation.Role != ConversationProject {
			Raise("invalid_input", "Work requires a supervisor thread")
		}
		if conversation.Role == ConversationProject && input.ProjectID == "" {
			input.ProjectID = *conversation.ProjectId
		}
		if input.ProjectID != "" && !runtime.allowedProjects()[input.ProjectID] {
			Raise("invalid_input", "A configured project is required")
		}
		if input.ProjectID != "" {
			requireProjectActive(runtime.store, input.ProjectID)
		}
		if conversation.Role == ConversationProject && (conversation.ProjectId == nil || *conversation.ProjectId != input.ProjectID) {
			Raise("invalid_input", "The project thread cannot create work for another project")
		}
		source := kernelRow(runtime.store.Db, `SELECT id FROM messages WHERE id=? AND conversation_id=? AND role='user' AND kind='chat'
   AND (data IS NULL OR json_extract(data,'$.source') IS NULL)`, input.SourceMessageID, input.ConversationID)
		if source == nil {
			Raise("invalid_input", "Work requires a user message from this thread")
		}
		id := graphUUID()
		var projectID *string
		if input.ProjectID != "" {
			projectID = &input.ProjectID
		}
		runtime.store.CreateWork(id, input.ConversationID, input.SourceMessageID, input.Brief, projectID, input.Acceptance, NowMillis())
		runtime.store.Event(conversation.AnchorTaskId, "work.created", map[string]any{"workId": id, "projectId": input.ProjectID})
		return runtime.store.workInTransaction(id)
	})
	return workReceipt(result)
}

func (runtime *TaskRuntime) ReviseWork(id string, input WorkEdit, requestID string) WorkRecord {
	runtime.ensureOpen()
	input.Brief, input.Acceptance = normalizeWork(input.Brief, input.Acceptance)
	result := runtime.store.Command("work:revise:"+id, requestID, input, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		current := runtime.store.workInTransaction(id)
		if input.ProjectID != nil {
			if !runtime.allowedProjects()[*input.ProjectID] {
				Raise("invalid_input", "A configured project is required")
			}
			conversation := ConversationRowOf(runtime.store, current.ConversationID)
			if conversation.Role == ConversationProject && (conversation.ProjectId == nil || *conversation.ProjectId != *input.ProjectID) {
				Raise("invalid_input", "The project thread cannot assign work to another project")
			}
		}
		runtime.store.ReviseWork(id, input.ExpectedRevision, input.Brief, input.ProjectID, input.Acceptance, NowMillis())
		conversation := ConversationRowOf(runtime.store, current.ConversationID)
		runtime.store.Event(conversation.AnchorTaskId, "work.revised", map[string]any{"workId": id, "revision": input.ExpectedRevision + 1})
		return runtime.store.workInTransaction(id)
	})
	return workReceipt(result)
}

func workReceipt(value any) WorkRecord {
	if work, ok := value.(WorkRecord); ok {
		return work
	}
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var work WorkRecord
	if err = json.Unmarshal(data, &work); err != nil {
		panic(err)
	}
	return work
}
