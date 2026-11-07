package graph

import (
	"net/http"
)


func (app *GraphApp) serveConversationToolCalls(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	writeJSON(w, http.StatusOK, app.runtime.Conversations().ToolCalls(conversationID))
}

func (app *GraphApp) serveConversationToolCallCancel(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	toolCallID := r.PathValue("toolCallId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().CancelToolCall(
		conversationID, toolCallID, appBodyString(body, "requestId")))
}
