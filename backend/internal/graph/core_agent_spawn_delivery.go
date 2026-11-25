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
	withStoreTx(store, func(tx *TaskStore) any {
		deliverChildResultInTransaction(tx, child, operation, result)
		return nil
	})
}

func deliverChildResultInTransaction(store *TaskStore, child ConversationRow, operation Operation, result OperationResult) {
	scope := "child-result:" + child.Id
	text := childResultMessage(child, result)
	payload := map[string]any{"outcome": result.Outcome, "text": text}
	if _, replayed := deferredToolCommandReceipt(store, scope, operation.Id, payload); replayed {
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
	kind := "agent_result"
	if result.Outcome == "failed" {
		kind = "agent_failure"
	}
	source := map[string]any{"kind": "agent", "agentId": child.Id, "conversationId": child.Id, "taskId": child.AnchorTaskId, "operationId": operation.Id}
	data := map[string]any{"source": source}
	if parent.Kind == "node" {
		kernel := kernelStoreWithoutMigration(store)
		queued := NewGraphRuntime(kernel, parent.TaskId, nil).Chat(parent.NodeId, text, false)
		data["queueSeq"] = queuedSeq(queued)
		AppendNodeEntry(store, NodeEntryInput{
			TaskID: parent.TaskId, NodeID: parent.NodeId, InstanceID: nodeInstanceID(kernel.ListNodes(parent.TaskId), parent.NodeId),
			Role: "user", Kind: kind, Text: text, Data: data,
		})
	} else {
		target := ConversationRowOf(store, parent.ConversationId)
		state := MessageStatePending
		task := store.Task(target.AnchorTaskId)
		master := kernelRow(store.Db, "SELECT status FROM nodes WHERE task_id=? AND id='master'", target.AnchorTaskId)
		if task.Paused != 0 || (master != nil && (kernelString(master["status"]) == "preparing" || kernelString(master["status"]) == "running" || kernelString(master["status"]) == "blocked")) {
			state = MessageStateQueued
		}
		message := AppendMessage(store, MessageInput{
			ConversationID: target.Id, Role: MessageRoleUser, Kind: kind, Text: text, State: state, Data: data,
		})
		WakeMaster(store, WakeIntent{
			TaskID: target.AnchorTaskId, Kind: WakeKind(kind), DedupeKey: child.Id + ":" + operation.Id,
			Data: map[string]any{"agentId": child.Id, "operationId": operation.Id, "messageId": message.Id}, HasData: true,
		})
		RecoverMaster(store, target.AnchorTaskId, "message")
	}
	receipt := map[string]any{"agentId": child.Id, "parentAgentId": parent.Id, "operationId": operation.Id, "kind": kind}
	store.Event(parent.TaskId, "agent.result", receipt)
	deferredToolRecordCommand(store, scope, operation.Id, payload, receipt)
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
