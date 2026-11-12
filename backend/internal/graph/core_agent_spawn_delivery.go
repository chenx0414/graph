package graph

import (
	"strings"

	"unicode/utf8"
)

const childResultLimit = 20000

func DeliverChildResult(store *TaskStore, child ConversationRow, operation Operation, result OperationResult) {
	if child.Role != ConversationChild || operation.Kind != "agent" {
		return
	}
	row := kernelRow(store.Db, "SELECT parent_id FROM agents WHERE conversation_id=? AND kind='child'", child.Id)
	if row == nil {
		return
	}
	parent := AgentById(store, kernelString(row["parent_id"]))
	if parent == nil {
		return
	}
	text := childResultMessage(child, result)
	if parent.Kind == "node" {
		kernel := kernelStoreWithoutMigration(store)
		SendKernelNodeMessage(kernel, parent.TaskId, parent.NodeId, NodeMessageInput{
			Text: text, RequestID: "child-result:" + child.Id + ":" + operation.Id,
		}, nil)
		store.Event(child.AnchorTaskId, "agent.result.delivered", map[string]any{
			"agentId": child.Id, "parentAgentId": parent.Id, "operationId": operation.Id,
		})
		return
	}
	target := ConversationRowOf(store, parent.ConversationId)
	if target.Id == "" {
		return
	}
	state := MessageStatePending
	task := store.Task(target.AnchorTaskId)
	master := kernelRow(store.Db, "SELECT status FROM nodes WHERE task_id=? AND id='master'", target.AnchorTaskId)
	if task.Paused != 0 || (master != nil && (kernelString(master["status"]) == "preparing" || kernelString(master["status"]) == "running" || kernelString(master["status"]) == "blocked")) {
		state = MessageStateQueued
	}
	message := AppendMessage(store, MessageInput{
		ConversationID: target.Id, Role: MessageRoleUser, Kind: "agent_result", Text: text, State: state,
		Data: map[string]any{"source": map[string]any{"kind": "agent", "agentId": child.Id, "conversationId": child.Id, "taskId": child.AnchorTaskId}},
	})
	WakeMaster(store, WakeIntent{
		TaskID: target.AnchorTaskId, Kind: "agent_result", DedupeKey: child.Id,
		Data: map[string]any{"agentId": child.Id, "messageId": message.Id}, HasData: true,
	})
	RecoverMaster(store, target.AnchorTaskId, "message")
	store.Event(target.AnchorTaskId, "agent.result", map[string]any{
		"agentId": child.Id, "parentAgentId": parent.Id, "messageId": message.Id, "operationId": operation.Id,
	})
}

func childResultMessage(child ConversationRow, result OperationResult) string {
	text := ""
	if output, ok := result.Output.(map[string]any); ok {
		if value, ok := output["text"].(string); ok {
			text = value
		}
	}
	text = strings.TrimSpace(text)
	if text == "" {
		text = describeFailure(result.Output)
	}
	if utf8.RuneCountInString(text) > childResultLimit {
		text = string([]rune(text)[:childResultLimit]) + "\n…(结果已截断)"
	}
	header := "子 Agent " + child.Title + "（" + child.Id + "）返回结果"
	if result.Outcome == "failed" {
		header = "子 Agent " + child.Title + "（" + child.Id + "）执行失败"
	}
	return header + "\n\n" + text
}

func kernelStoreWithoutMigration(store *TaskStore) *KernelStore {
	return &KernelStore{Store: store, Db: store.Db, DB: store.Db, Content: NewKernelContent(store.Db)}
}
