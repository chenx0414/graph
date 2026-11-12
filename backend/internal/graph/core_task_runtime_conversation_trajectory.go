package graph

func (conversations *TaskRuntimeConversations) Trajectory(conversationId string) *ConversationTrajectory {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	return BuildConversationTrajectory(runtime.store, conversationId)
}
