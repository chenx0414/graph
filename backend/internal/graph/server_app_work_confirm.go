package graph

import "net/http"

func (app *GraphApp) serveWorkConfirm(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := WorkConfirmInput{
		WorkRevision:  draftPositiveInteger(body["workRevision"], "workRevision"),
		Version:       draftPositiveInteger(body["version"], "version"),
		DraftRevision: draftPositiveInteger(body["draftRevision"], "draftRevision"),
		GraphKey:      appBodyString(body, "graphKey"),
	}
	if value, exists := body["targetBranch"]; exists && value != nil {
		branch, ok := value.(string)
		if !ok {
			Raise("invalid_input", "targetBranch must be a string")
		}
		input.TargetBranch = &branch
	}
	writeJSON(w, http.StatusOK, app.runtime.ConfirmWorkGraph(r.PathValue("workId"), input, appBodyString(body, "requestId")))
}

func (app *GraphApp) serveWorkGraphs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": app.runtime.store.WorkGraphs(r.PathValue("workId"))})
}
