package graph

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"context"
)

func taskRuntimeTaskCost(runtime *TaskRuntime, taskId string) CostSummary {
	totals := runtime.store.ensureTaskInvocationTotals(taskId)
	amounts := totals.Costs
	order := make([]string, 0, len(amounts))
	for currency := range amounts {
		order = append(order, currency)
	}
	for index := 1; index < len(order); index++ {
		for back := index; back > 0 && order[back] < order[back-1]; back-- {
			order[back], order[back-1] = order[back-1], order[back]
		}
	}
	for range runtime.kernel.ProviderCalls(taskId) {
		totals.CostUnknown++
	}
	return costSummary(totals.CostUnknown > 0, amounts, order)
}

func (conversations *TaskRuntimeConversations) Proposal(conversationId string, version int) any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	if version < 1 {
		Raise("invalid_input", "A positive proposal version is required")
	}
	conversation := ConversationRowOf(runtime.store, conversationId)
	anchor := runtime.store.Task(conversation.AnchorTaskId)
	proposal := taskRuntimeConversationProposal(runtime.store, anchor.ID, version, int(anchor.RequirementVersion), true)
	if proposal == nil {
		Raise("not_found", "Proposal v"+itoa(version)+" was not found")
	}
	return proposal
}

func (conversations *TaskRuntimeConversations) Events(conversationId string, after int, limit int) []TaskUpdate {
	runtime := conversations.runtime
	runtime.ensureOpen()
	cap := limit
	if cap <= 0 {
		cap = 200
	}
	if cap > 500 {
		cap = 500
	}
	ids := runtime.conversationTaskIds(conversationId)
	out := []TaskUpdate{}
	for _, row := range runtime.conversationEventRows(ids, after, cap) {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		out = append(out, TaskUpdate{
			Cursor:    int(kernelInt(row["cursor"])),
			TaskId:    kernelString(row["task_id"]),
			Type:      kernelString(row["type"]),
			Data:      data,
			Timestamp: kernelInt(row["timestamp"]),
		})
	}
	return out
}

func (runtime *TaskRuntime) conversationTaskIds(conversationId string) []string {
	anchor := ConversationRowOf(runtime.store, conversationId).AnchorTaskId
	seen := map[string]bool{}
	ids := []string{}
	for _, id := range []string{anchor} {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	for _, row := range kernelRows(runtime.store.Db, `SELECT t.id FROM tasks t
 LEFT JOIN kernel_graph_owners g ON g.task_id=t.id
 LEFT JOIN tasks owner ON owner.id=g.owner_task_id
 WHERE COALESCE(owner.conversation_id,t.conversation_id)=? OR
   (t.conversation_id=? AND EXISTS (SELECT 1 FROM conversations source WHERE source.id=? AND source.role='history'))`, conversationId, conversationId, conversationId) {
		id := kernelString(row["id"])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

func (runtime *TaskRuntime) conversationEventRows(ids []string, after int, limit int) []map[string]any {
	if len(ids) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	params := []any{}
	for _, id := range ids {
		params = append(params, id)
	}
	params = append(params, after, limit)
	return kernelRows(runtime.store.Db, "SELECT cursor,task_id,type,data,timestamp FROM events WHERE task_id IN ("+placeholders+") AND cursor>? ORDER BY cursor LIMIT ?", params...)
}

func (conversations *TaskRuntimeConversations) Watch(conversationId string, after int) TaskWatch {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	if after < 0 {
		Raise("invalid_cursor", "Invalid event cursor")
	}
	stop := make(chan struct{})
	var once sync.Once
	ctx, cancel := context.WithCancel(context.Background())
	cursor := after
	pending := []TaskUpdate{}
	return TaskWatch{
		Next: func() (TaskUpdate, bool) {
			for {
				select {
				case <-stop:
					return TaskUpdate{}, false
				default:
				}
				if len(pending) > 0 {
					update := pending[0]
					pending = pending[1:]
					return update, true
				}
				wake := runtime.store.WaitForChange(ctx)
				rows := runtime.conversationEventRows(runtime.conversationTaskIds(conversationId), cursor, 100)
				if len(rows) > 0 {
					wake.Cancel()
					for _, row := range rows {
						cursor = int(kernelInt(row["cursor"]))
						var data any
						if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
							panic(err)
						}
						pending = append(pending, TaskUpdate{
							Cursor:    cursor,
							TaskId:    kernelString(row["task_id"]),
							Type:      kernelString(row["type"]),
							Data:      data,
							Timestamp: kernelInt(row["timestamp"]),
						})
					}
					continue
				}
				select {
				case <-wake.Promise:
				case <-time.After(250 * time.Millisecond):
				case <-stop:
					return TaskUpdate{}, false
				}
				wake.Cancel()
			}
		},
		Stop: func() { once.Do(func() { close(stop); cancel() }) },
	}
}

func (conversations *TaskRuntimeConversations) Attachment(messageId string, index int) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	if index < 0 {
		Raise("not_found", "Attachment not found")
	}
	row := kernelRow(runtime.store.Db, "SELECT data FROM messages WHERE id=?", messageId)
	if row == nil {
		Raise("not_found", "Image attachment not found")
	}
	attachment := taskRuntimeAttachmentAt(row, index)
	if attachment == nil {
		Raise("not_found", "Image attachment not found")
	}
	return map[string]any{"type": attachment.Type, "bytes": attachment.Data}
}

func taskRuntimeAttachmentAt(row map[string]any, index int) *AttachmentInput {
	if row["data"] == nil {
		return nil
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
		return nil
	}
	attachments, ok := data["attachments"].([]any)
	if !ok || index >= len(attachments) {
		return nil
	}
	record, ok := jsonRecord(attachments[index])
	if !ok {
		return nil
	}
	kind, _ := record["type"].(string)
	if kind != "image/png" && kind != "image/jpeg" && kind != "image/webp" && kind != "image/gif" {
		return nil
	}
	encoded, ok := record["data"].(string)
	if !ok {
		return nil
	}
	size := int64(0)
	if value, ok := record["size"].(float64); ok {
		size = int64(value)
	}
	name, _ := record["name"].(string)
	text, _ := record["text"].(string)
	return &AttachmentInput{Name: name, Type: kind, Size: size, Text: text, Data: &encoded}
}

func (conversations *TaskRuntimeConversations) History(conversationId string, query NodeEntryQuery) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	return map[string]any{"messages": ListMessages(runtime.store, conversationId, messageQueryOf(query))}
}

func (conversations *TaskRuntimeConversations) SelectModel(conversationId, model, thinkingLevel, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	if strings.TrimSpace(model) == "" {
		Raise("invalid_input", "A model is required")
	}
	requested := taskRuntimeAsThinkingLevel(thinkingLevel)
	result := runtime.store.Command("conversation:"+conversationId, requestId, map[string]any{
		"type": "select_model", "model": strings.TrimSpace(model), "thinkingLevel": requested,
	}, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		var entry *ConfiguredModel
		for _, candidate := range runtime.liveConfiguredEntries() {
			if candidate.Id == strings.TrimSpace(model) {
				found := candidate
				entry = &found
				break
			}
		}
		if entry == nil {
			Raise("model_unavailable", "The selected model is not configured")
		}
		level := EffectiveThinkingLevel(entry.ModelEntry, &requested)
		anchor := ConversationRowOf(runtime.store, conversationId).AnchorTaskId
		master := kernelRow(runtime.store.Db, `
          SELECT n.instance_id,n.spec
          FROM nodes n
          WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'
        `, anchor)
		if master == nil || kernelString(master["instance_id"]) == "" {
			Raise("model_unavailable", "This conversation has no master Agent instance")
		}
		var spec NodeSpec
		if err := json.Unmarshal([]byte(kernelString(master["spec"])), &spec); err != nil {
			panic(err)
		}
		currentLevel := ConversationRowOf(runtime.store, conversationId).ThinkingLevel
		changed := (spec.Model == nil || *spec.Model != entry.Id) || currentLevel == nil || *currentLevel != string(level)
		spec.Model = &entry.Id
		runtime.store.SetNodeSpec(anchor, spec.Id, CanonicalJSON(spec))
		runtime.store.SetInstanceModel(kernelString(master["instance_id"]), entry.Id)
		runtime.store.SetConversationThinkingLevel(conversationId, string(level))
		if changed {
			runtime.store.Event(anchor, "conversation.model_selected", map[string]any{"model": entry.Id, "thinkingLevel": string(level)})
		}
		return map[string]any{
			"conversationId": conversationId,
			"model":          entry.Id,
			"thinkingLevel":  string(level),
			"changed":        changed,
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

type TaskRuntimeSupervisor struct {
	runtime *TaskRuntime
	taskId  string
}
