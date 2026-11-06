package graph

import (
	"net/http"
)

// The tool call routes: what a conversation's background calls are, and how
// one is withdrawn.
//
// The paths are the frozen contract the console and the end-to-end suite share
// (docs/agent/async-tool-execution.md §3.5): the read side answers with the
// calls of one conversation, the write side answers with the call's state
// after the withdrawal. Both are answered from the durable rows, so a console
// reload (or a daemon restart) reads the same facts the running process would
// have told it.

// serveConversationToolCalls lists the background calls of one conversation.
func (app *GraphApp) serveConversationToolCalls(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	writeJSON(w, http.StatusOK, app.runtime.Conversations().ToolCalls(conversationID))
}

// serveConversationToolCallCancel withdraws one background call.
func (app *GraphApp) serveConversationToolCallCancel(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	toolCallID := r.PathValue("toolCallId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().CancelToolCall(
		conversationID, toolCallID, appBodyString(body, "requestId")))
}
