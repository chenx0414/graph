package graph

import (
	"strings"
)

func resumeConversationForDeferredTool(store *TaskStore, call DeferredToolCall) {
	conversation := ConversationRowOf(store, call.ConversationId)
	node := kernelRow(store.Db, "SELECT status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'", conversation.AnchorTaskId)
	anchor := store.Task(conversation.AnchorTaskId)
	state := MessageStatePending
	if anchor.Paused != 0 || (node != nil && (kernelString(node["status"]) == "preparing" || kernelString(node["status"]) == "running")) {
		state = MessageStateQueued
	}
	if inject := conversationInjectorOf(call.ConversationId); inject != nil && inject(deferredToolResumeText(call)) {
		AppendMessage(store, MessageInput{
			ConversationID: call.ConversationId, Role: MessageRoleUser, Kind: "chat",
			Text: deferredToolResumeText(call), State: MessageStateDone,
			Data: map[string]any{"source": map[string]any{
				"kind": "tool_settled", "toolCallId": call.ToolCallId, "toolName": call.ToolName, "state": string(call.State),
				"delivered": "steer",
			}},
		})
		return
	}
	AppendMessage(store, MessageInput{
		ConversationID: call.ConversationId, Role: MessageRoleUser, Kind: "chat",
		Text: deferredToolResumeText(call), State: state,
		Data: map[string]any{"source": map[string]any{
			"kind": "tool_settled", "toolCallId": call.ToolCallId, "toolName": call.ToolName, "state": string(call.State),
		}},
	})
	RecoverMaster(store, conversation.AnchorTaskId, "message")
}

func deferredToolResumeText(call DeferredToolCall) string {
	name := strings.TrimSpace(call.ToolName)
	if name == "" {
		name = "后台工具"
	}
	return name + " 已经结束（" + string(call.State) + "），结果在会话的工具调用里；请读它继续。"
}
