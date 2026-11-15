package graph

import (
	"context"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

func (conversations *TaskRuntimeConversations) NewContext(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	row := ConversationRowOf(runtime.store, conversationId)
	master := kernelRow(runtime.store.Db, "SELECT instance_id FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'", row.AnchorTaskId)
	if master == nil || kernelString(master["instance_id"]) == "" {
		Raise("invalid_state", "This conversation has no master Agent instance")
	}
	identity := kernelString(master["instance_id"])
	reset, err := pigkernel.ResetConversation(context.Background(), runtime.store.Path, identity)
	if err != nil {
		Raise("internal", err.Error())
	}
	result := runtime.store.Command("conversation:"+conversationId+":context", requestId, map[string]any{
		"type": "new_context", "conversationId": conversationId,
	}, func() any {
		runtime.store.Event(row.AnchorTaskId, "conversation.context_reset", map[string]any{
			"conversationId": conversationId, "identity": identity, "reset": reset,
		})
		return map[string]any{"conversationId": conversationId, "reset": reset}
	})
	return result.(map[string]any)
}
