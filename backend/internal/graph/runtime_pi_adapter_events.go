package graph

import (
	"strings"

	"fmt"
	"strconv"
)

type piAdapterLiveTurn struct {
	store                   *TaskStore
	operation               Operation
	instanceId              string
	gate                    *TaskSendGate
	conversation            *ConversationRow
	parts                   map[string]*piAdapterPart
	partsOrder              []string
	entrySeq                int
	currentEntryId          string
	ordinal                 int
	toolSummaries           map[string]string
	activeConversationTools map[string]bool
	toolActivity            []PiAdapterToolActivity
	activity                []PiAdapterActivityRecord
	narrationByEntry        map[string]*PiAdapterActivityRecord
	toolOrdinals            map[string]int
	persistEntries          bool
	sawAssistantMessageEnd  bool
	compacting              bool
}

func newPiAdapterLiveTurn(store *TaskStore, operation Operation, instanceId string, gate *TaskSendGate, conversation *ConversationRow) *piAdapterLiveTurn {
	return &piAdapterLiveTurn{
		store: store, operation: operation, instanceId: instanceId, gate: gate, conversation: conversation,
		parts: map[string]*piAdapterPart{}, partsOrder: []string{},
		toolSummaries: map[string]string{}, activeConversationTools: map[string]bool{},
		toolActivity: []PiAdapterToolActivity{}, activity: []PiAdapterActivityRecord{},
		narrationByEntry: map[string]*PiAdapterActivityRecord{}, toolOrdinals: map[string]int{},
		persistEntries: conversation == nil,
	}
}

func (live *piAdapterLiveTurn) nextOrdinal() int {
	live.ordinal++
	return live.ordinal
}

func (live *piAdapterLiveTurn) flushPart(part *piAdapterPart, force bool) {
	if live.conversation == nil || part.buffer == "" {
		return
	}
	now := NowMillis()
	if !force && now-part.lastFlush < CONVERSATION_DELTA_FLUSH_MS {
		return
	}
	text := part.buffer
	part.buffer = ""
	part.lastFlush = now
	PublishConversationDelta(live.store, PiAdapterConversationDelta{
		TaskId: live.operation.TaskId, ConversationId: live.conversation.Id, OperationId: live.operation.Id,
		EntryId: part.entryId, PartId: part.partId, Ordinal: part.ordinal, Delta: text,
		Text: part.text, Length: len([]rune(part.text)),
	})
}

func (live *piAdapterLiveTurn) flushDeltas(force bool) {
	for _, key := range live.partsOrder {
		live.flushPart(live.parts[key], force)
	}
}

func (live *piAdapterLiveTurn) livePart(contentIndex int) *piAdapterPart {
	if live.currentEntryId == "" {
		live.entrySeq++
		live.currentEntryId = fmt.Sprintf("entry-%d", live.entrySeq)
	}
	partId := fmt.Sprintf("%d", contentIndex)
	key := live.currentEntryId + "\x00" + partId
	if existing, ok := live.parts[key]; ok {
		return existing
	}
	part := &piAdapterPart{entryId: live.currentEntryId, partId: partId, ordinal: live.nextOrdinal()}
	live.parts[key] = part
	live.partsOrder = append(live.partsOrder, key)
	narration := &PiAdapterActivityRecord{Type: "narration", Ordinal: part.ordinal}
	live.activity = append(live.activity, *narration)
	live.narrationByEntry[live.currentEntryId] = narration
	return part
}

func (live *piAdapterLiveTurn) handle(event map[string]any) {
	kind, _ := event["type"].(string)
	switch kind {
	case "context_reset":
		live.store.Event(live.operation.TaskId, "session.context_reset", map[string]any{
			"operationId": live.operation.Id, "nodeId": live.operation.NodeId,
			"estimatedTokens": event["estimatedTokens"], "contextWindow": event["contextWindow"],
		})
		return
	case "message_start":
		live.entrySeq++
		live.currentEntryId = fmt.Sprintf("entry-%d", live.entrySeq)
		return
	case "message_update":
		update, _ := event["assistantMessageEvent"].(map[string]any)
		if update == nil || update["type"] != "text_delta" {
			return
		}
		contentIndex := int(asFloatValue(update["contentIndex"]))
		delta, _ := update["delta"].(string)
		part := live.livePart(contentIndex)
		part.text += delta
		part.buffer += delta
		live.flushPart(part, false)
		return
	case "message_end":
		message, _ := event["message"].(map[string]any)
		role, _ := message["role"].(string)
		text := piAdapterAssistantText(message)
		if role == "assistant" && strings.TrimSpace(text) != "" {
			if live.persistEntries {
				live.sawAssistantMessageEnd = true
				AppendNodeEntry(live.store, NodeEntryInput{
					TaskID: live.operation.TaskId, NodeID: live.operation.NodeId, InstanceID: live.instanceId,
					ActivationID: live.operation.ActivationId, OperationID: live.operation.Id, Role: "assistant", Kind: "message", Text: text,
				})
			} else {
				narration := live.narrationByEntry[live.currentEntryId]
				if narration != nil {
					narration.Text = text
				} else {
					record := PiAdapterActivityRecord{Type: "narration", Text: text, Ordinal: live.nextOrdinal()}
					live.narrationByEntry[live.currentEntryId] = &record
					live.activity = append(live.activity, record)
				}
			}
		}
		if !live.persistEntries {
			live.flushDeltas(true)
			live.currentEntryId = ""
		}
		return
	case "tool_execution_start":
		toolName, _ := event["toolName"].(string)
		toolCallId, _ := event["toolCallId"].(string)
		if live.persistEntries {
			AppendNodeEntry(live.store, NodeEntryInput{
				TaskID: live.operation.TaskId, NodeID: live.operation.NodeId, InstanceID: live.instanceId,
				ActivationID: live.operation.ActivationId, OperationID: live.operation.Id, Role: "tool", Kind: "call",
				Text: summarizeToolCall(toolName, event["args"]),
				Data: map[string]any{"toolCallId": toolCallId, "toolName": toolName},
			})
		}
		if live.conversation == nil {
			return
		}
		deferred := live.bindDeferredStart(toolName, toolCallId, event["args"])
		summary := summarizeToolCall(toolName, event["args"])
		live.toolSummaries[toolCallId] = summary
		callOrdinal := live.nextOrdinal()
		live.toolOrdinals[toolCallId] = callOrdinal
		live.activity = append(live.activity, PiAdapterActivityRecord{
			Type: "tool", ToolCallId: toolCallId, Name: toolName, Summary: summary, State: "done", Ordinal: callOrdinal,
		})
		live.flushDeltas(true)
		live.activeConversationTools[toolCallId] = true
		PersistConversationActivity(live.store, live.conversation.Id, live.operation.Id, live.operation.Attempt,
			ConversationActivityRecords(live.activity, ""), live.activeConversationTools, deferredRunningIds(deferred))
		if deferred != nil && !DeferredToolCallActive(deferred.State) {
			SettleConversationToolCall(live.store, *deferred)
		}
		live.store.Event(live.operation.TaskId, "message.tool", map[string]any{
			"operationId": live.operation.Id, "phase": "start", "toolCallId": toolCallId, "toolName": toolName,
			"summary": summary, "ordinal": callOrdinal,
		})
	case "tool_execution_end":
		toolName, _ := event["toolName"].(string)
		toolCallId, _ := event["toolCallId"].(string)
		isError, _ := event["isError"].(bool)
		reason := ""
		if isError {
			reason = ToolResultText(event["result"], 2_000)
		}
		if live.persistEntries {
			text := "工具执行完成"
			if isError {
				text = "工具执行失败：" + truncateRunes(reason, 400)
			}
			data := map[string]any{"toolCallId": toolCallId, "toolName": toolName, "isError": isError}
			if reason != "" {
				data["message"] = reason
			}
			AppendNodeEntry(live.store, NodeEntryInput{
				TaskID: live.operation.TaskId, NodeID: live.operation.NodeId, InstanceID: live.instanceId,
				ActivationID: live.operation.ActivationId, OperationID: live.operation.Id, Role: "tool", Kind: "result",
				Text: text, Data: data,
			})
		}
		if live.conversation == nil {
			return
		}
		summary := live.toolSummaries[toolCallId]
		if summary == "" {
			summary = toolName
		}
		deferred := live.bindDeferredEnd(toolCallId, event["result"])
		state := "done"
		if isError {
			state = "error"
		}
		if deferred != nil && DeferredToolCallActive(deferred.State) {
			state = "running"
		}
		live.toolActivity = append(live.toolActivity, PiAdapterToolActivity{
			ToolCallId: toolCallId, Name: toolName, Summary: summary, State: state,
		})
		for i := range live.activity {
			if live.activity[i].Type == "tool" && live.activity[i].ToolCallId == toolCallId {
				live.activity[i].State = state
				if isError {
					live.activity[i].Message = truncateRunes(reason, 400)
				}
			}
		}
		delete(live.activeConversationTools, toolCallId)
		PersistConversationActivity(live.store, live.conversation.Id, live.operation.Id, live.operation.Attempt,
			ConversationActivityRecords(live.activity, ""), live.activeConversationTools, deferredRunningIds(deferred))
		if deferred != nil {
			SettleConversationToolCall(live.store, *deferred)
		}
		live.store.Event(live.operation.TaskId, "message.tool", map[string]any{
			"operationId": live.operation.Id, "phase": "end", "toolCallId": toolCallId, "toolName": toolName,
			"summary": summary, "isError": isError, "ordinal": live.toolOrdinals[toolCallId],
		})
	case "compaction_start":
		live.compacting = true
		live.gate.SetPurpose("compaction")
		reason, _ := event["reason"].(string)
		live.store.Event(live.operation.TaskId, "session.compaction_started", map[string]any{
			"nodeId": live.operation.NodeId, "operationId": live.operation.Id, "reason": reason,
		})
	case "compaction_end":
		live.compacting = false
		live.gate.SetPurpose("completion")
		aborted, _ := event["aborted"].(bool)
		result, _ := event["result"].(map[string]any)
		reason, _ := event["reason"].(string)
		if !aborted && result != nil {
			tokensBefore := result["tokensBefore"]
			completionSequence := piAdapterCompletionSequence(live.store, live.instanceId)
			data := map[string]any{
				"reason": reason, "operationId": live.operation.Id, "tokensBefore": tokensBefore,
				"completionSequence": completionSequence,
			}
			if summary := result["summary"]; summary != nil {
				data["summary"] = summary
			}
			if estimated, ok := result["estimatedTokensAfter"]; ok {
				data["tokensAfter"] = estimated
			}
			summary, _ := result["summary"].(string)
			if live.persistEntries {
				AppendNodeEntry(live.store, NodeEntryInput{
					TaskID: live.operation.TaskId, NodeID: live.operation.NodeId, InstanceID: live.instanceId,
					ActivationID: live.operation.ActivationId, OperationID: live.operation.Id, Role: "system", Kind: "compaction",
					Text: summary, Data: data,
				})
			}
			if !live.persistEntries && live.conversation != nil {
				operationId := live.operation.Id
				AppendMessage(live.store, MessageInput{
					ConversationID: live.conversation.Id, Role: MessageRoleSystem, Kind: "compaction",
					Text: compactionNotice(data) + "\n" + compactionPointer(live.conversation.Id), Data: data, OperationID: &operationId,
				})
			}
			live.store.Event(live.operation.TaskId, "session.compacted", map[string]any{"nodeId": live.operation.NodeId, "data": data})
			return
		}
		errorMessage, _ := event["errorMessage"].(string)
		if errorMessage == "" {
			errorMessage = "compaction aborted"
		}
		kind := "session.compaction_failed"
		if IsCompactionNoop(errorMessage) {
			kind = "session.compaction_skipped"
		}
		live.store.Event(live.operation.TaskId, kind, map[string]any{
			"nodeId": live.operation.NodeId, "operationId": live.operation.Id, "reason": reason, "error": errorMessage,
		})
	}
}

func compactionNotice(data map[string]any) string {
	notice := "上下文已自动压缩：更早的对话收进了摘要，原始记录仍在，可用历史检索（history_search）按关键词或条目 id 找回。"
	if tokens := kernelInt(data["tokensAfter"]); tokens > 0 {
		notice += " 压缩后约 " + strconv.FormatInt(tokens, 10) + " tokens。"
	}
	return notice
}

func (live *piAdapterLiveTurn) bindDeferredStart(toolName, toolCallId string, args any) *DeferredToolCall {
	id, ok := claimDeferredToolStart(live.operation.Id, toolName, args)
	if !ok {
		return nil
	}
	return BindDeferredToolCallModelCall(live.store, id, toolCallId)
}

func (live *piAdapterLiveTurn) bindDeferredEnd(toolCallId string, result any) *DeferredToolCall {
	text := ToolResultText(result, 2_000)
	id, ok := deferredToolReceiptOf(text)
	if !ok {
		return DeferredToolCallByModelCall(live.store, live.conversationId(), toolCallId)
	}
	return BindDeferredToolCallModelCall(live.store, id, toolCallId)
}

func (live *piAdapterLiveTurn) conversationId() string {
	if live.conversation == nil {
		return ""
	}
	return live.conversation.Id
}

func deferredRunningIds(call *DeferredToolCall) map[string]bool {
	if call == nil || !DeferredToolCallActive(call.State) {
		return nil
	}
	if len(call.ToolCallId) >= len(deferredToolCallPlaceholderPrefix) && call.ToolCallId[:len(deferredToolCallPlaceholderPrefix)] == deferredToolCallPlaceholderPrefix {
		return nil
	}
	return map[string]bool{call.ToolCallId: true}
}
