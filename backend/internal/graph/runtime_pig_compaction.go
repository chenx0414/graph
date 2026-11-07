package graph

func pigCompactionInstructions() string {
	return "Summarize this conversation so the work can continue from the summary alone. " +
		"Keep it short: what the user asked for, decisions taken, files and commands that matter, " +
		"what is still open. End with one sentence saying that the earlier conversation is " +
		"preserved in full in the durable transcript and can be searched with the " + historyToolNameGraph +
		" tool, by keyword or one entry by id."
}

const historyToolNameGraph = "history_search"

func compactionPointer(conversationId string) string {
	return "你正在继续会话 " + conversationId + "。一边进行一边从中检索关键上下文。"
}
