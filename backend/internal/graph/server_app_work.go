package graph

import (
	"math"
	"net/http"
)

func workAcceptance(body map[string]any) []string {
	raw, ok := body["acceptance"].([]any)
	if !ok {
		Raise("invalid_input", "acceptance must be an array of strings")
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		text, ok := v.(string)
		if !ok {
			Raise("invalid_input", "acceptance must be an array of strings")
		}
		out = append(out, text)
	}
	return out
}
func (app *GraphApp) serveWorkCreate(w http.ResponseWriter, r *http.Request) {
	b := appJSONBody(w, r)
	input := WorkCreate{ConversationID: appBodyString(b, "conversationId"), ProjectID: appBodyString(b, "projectId"), SourceMessageID: appBodyString(b, "sourceMessageId"), Brief: appBodyString(b, "brief"), Acceptance: workAcceptance(b)}
	writeJSON(w, http.StatusOK, app.runtime.CreateWork(input, appBodyString(b, "requestId")))
}
func (app *GraphApp) serveWork(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.store.Work(r.PathValue("workId")))
}
func (app *GraphApp) serveWorkList(w http.ResponseWriter, r *http.Request) {
	project := r.URL.Query().Get("projectId")
	if !app.runtime.allowedProjects()[project] {
		Raise("invalid_input", "A configured project is required")
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": app.runtime.store.ProjectWork(project)})
}
func (app *GraphApp) serveWorkRevise(w http.ResponseWriter, r *http.Request) {
	b := appJSONBody(w, r)
	revision, ok := b["expectedRevision"].(float64)
	if !ok || revision < 1 || revision > 9007199254740991 || math.Trunc(revision) != revision {
		Raise("invalid_input", "A positive expectedRevision is required")
	}
	var projectID *string
	if value, exists := b["projectId"]; exists {
		text, valid := value.(string)
		if !valid || text == "" {
			Raise("invalid_input", "projectId must name a configured project")
		}
		projectID = &text
	}
	input := WorkEdit{ProjectID: projectID, ExpectedRevision: int64(revision), Brief: appBodyString(b, "brief"), Acceptance: workAcceptance(b)}
	writeJSON(w, http.StatusOK, app.runtime.ReviseWork(r.PathValue("workId"), input, appBodyString(b, "requestId")))
}
