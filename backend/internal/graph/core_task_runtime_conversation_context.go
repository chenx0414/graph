package graph

import (
	"context"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

func (conversations *TaskRuntimeConversations) NewContext(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	row := ConversationRowOf(runtime.store, conversationId)
	errorText := ""
	result := runtime.store.Command("conversation:"+conversationId+":context", requestId, map[string]any{
		"type": "new_context", "conversationId": conversationId,
	}, func() any {
		master := kernelRow(runtime.store.Db, "SELECT instance_id FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'", row.AnchorTaskId)
		if master == nil || kernelString(master["instance_id"]) == "" {
			Raise("invalid_state", "This conversation has no master Agent instance")
		}
		reset, err := pigkernel.ResetConversation(context.Background(), runtime.store.Path, kernelString(master["instance_id"]))
		if err != nil {
			errorText = err.Error()
			return map[string]any{"conversationId": conversationId, "reset": false, "error": errorText}
		}
		runtime.store.Event(row.AnchorTaskId, "conversation.context_reset", map[string]any{
			"conversationId": conversationId, "identity": kernelString(master["instance_id"]), "reset": reset,
		})
		return map[string]any{"conversationId": conversationId, "reset": reset}
	})
	if result == nil {
		return map[string]any{"conversationId": conversationId, "reset": false, "error": errorText}
	}
	return result.(map[string]any)
}
