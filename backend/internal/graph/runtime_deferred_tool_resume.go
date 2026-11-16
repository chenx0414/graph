package graph

import (
	"strings"
)

func queueDeferredToolResume(store *TaskStore, call DeferredToolCall) string {
	conversation := ConversationRowOf(store, call.ConversationId)
	node := kernelRow(store.Db, "SELECT status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'", conversation.AnchorTaskId)
	anchor := store.Task(conversation.AnchorTaskId)
	state := MessageStatePending
	if anchor.Paused != 0 || (node != nil && (kernelString(node["status"]) == "preparing" || kernelString(node["status"]) == "running")) {
		state = MessageStateQueued
	}
	AppendMessage(store, MessageInput{
		ConversationID: call.ConversationId, Role: MessageRoleUser, Kind: "chat",
		Text: deferredToolResumeText(call), State: state,
		Data: map[string]any{"source": map[string]any{
			"kind": "tool_settled", "form": "notice", "summary": deferredToolName(call) + " 已结束",
			"toolCallId": call.ToolCallId, "toolName": call.ToolName, "state": string(call.State),
		}},
	})
	return conversation.AnchorTaskId
}

func resumeConversationForDeferredTool(store *TaskStore, call DeferredToolCall) {
	RecoverMaster(store, queueDeferredToolResume(store, call), "message")
}

func deferredToolName(call DeferredToolCall) string {
	name := strings.TrimSpace(call.ToolName)
	if name == "" {
		name = "后台工具"
	}
	return name
}

func deferredToolResumeText(call DeferredToolCall) string {
	return deferredToolName(call) + " 已经结束（" + string(call.State) + "），结果在会话的工具调用里；请读它继续。"
}

func queueDeferredToolAnchor(store *TaskStore, call DeferredToolCall) string {
	row := kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE id=?", call.ConversationId)
	if row == nil {
		return ""
	}
	return kernelString(row["anchor_task_id"])
}
