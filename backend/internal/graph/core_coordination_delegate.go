package graph

import (
	"strings"
)

type DelegateWorkInput struct {
	ProjectID       string   `json:"projectId"`
	SourceMessageID string   `json:"sourceMessageId"`
	Brief           string   `json:"brief"`
	Acceptance      []string `json:"acceptance"`
	RequestID       string   `json:"requestId"`
}

func (runtime *TaskRuntime) DelegateFromGlobal(taskID string, input DelegateWorkInput) any {
	caller := ConversationForTask(runtime.store, taskID)
	if caller == nil || caller.Role != ConversationGlobal || caller.AnchorTaskId != taskID {
		Raise("permission", "Only the global supervisor can delegate project work")
	}
	if len(input.Acceptance) == 0 {
		Raise("invalid_input", "Clarify at least one acceptance condition before delegation")
	}
	if strings.TrimSpace(input.SourceMessageID) == "" {
		source := kernelRow(runtime.store.Db, `SELECT id FROM messages WHERE conversation_id=? AND role='user' AND kind='chat' AND state='delivered'
   AND (data IS NULL OR json_extract(data,'$.source') IS NULL) ORDER BY seq DESC LIMIT 1`, caller.Id)
		if source == nil {
			Raise("invalid_input", "There is no delivered user message to authorize this work")
		}
		input.SourceMessageID = kernelString(source["id"])
	}
	work := runtime.CreateWork(WorkCreate{ConversationID: caller.Id, ProjectID: input.ProjectID, SourceMessageID: input.SourceMessageID, Brief: input.Brief, Acceptance: input.Acceptance}, input.RequestID)
	thread := runtime.OpenProjectThread(input.ProjectID, input.RequestID+":thread")
	result := runtime.store.Command("work:delegate:"+work.ID, input.RequestID, map[string]any{"revision": work.Revision, "target": thread.ConversationID}, func() any {
		requireProjectActive(runtime.store, input.ProjectID)
		current := runtime.store.workInTransaction(work.ID)
		if current.ProjectID == nil || *current.ProjectID != input.ProjectID || current.ConversationID != caller.Id {
			Raise("permission", "Work does not belong to this supervisor and project")
		}
		runtime.store.MarkWorkDispatched(work.ID, work.Revision)
		target := ConversationRowOf(runtime.store, thread.ConversationID)
		text := "[来自全局主管的委派]\n工作 ID: " + work.ID + "\n工作修订: " + itoa(int(work.Revision)) + "\n目标: " + work.Brief + "\n验收条件:\n- " + strings.Join(work.Acceptance, "\n- ")
		node := kernelRow(runtime.store.Db, "SELECT status FROM nodes WHERE task_id=? AND id='master'", target.AnchorTaskId)
		state := MessageStatePending
		if runtime.store.Task(target.AnchorTaskId).Paused != 0 || (node != nil && (kernelString(node["status"]) == "preparing" || kernelString(node["status"]) == "running" || kernelString(node["status"]) == "blocked")) {
			state = MessageStateQueued
		}
		msg := AppendMessage(runtime.store, MessageInput{ConversationID: target.Id, Role: MessageRoleUser, Kind: "chat", Text: text, State: state, Data: map[string]any{"source": map[string]any{"kind": "agent", "conversationId": caller.Id, "taskId": taskID}, "workId": work.ID}})
		WakeMaster(runtime.store, WakeIntent{TaskID: target.AnchorTaskId, Kind: "work_delegated", DedupeKey: work.ID, Data: map[string]any{"workId": work.ID, "sourceConversationId": caller.Id}, HasData: true})
		runtime.store.Event(target.AnchorTaskId, "work.delegated", map[string]any{"workId": work.ID, "messageId": msg.Id, "sourceConversationId": caller.Id})
		return map[string]any{"workId": work.ID, "projectId": input.ProjectID, "conversationId": target.Id, "messageId": msg.Id}
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return result
}
