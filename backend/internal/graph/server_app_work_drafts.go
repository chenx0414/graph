package graph

import (
	"math"
	"net/http"
	"strconv"
)

func draftPositiveInteger(value any, name string) int64 {
	n, ok := value.(float64)
	if !ok || n < 1 || n > 9007199254740991 || math.Trunc(n) != n {
		Raise("invalid_input", name+" must be a positive safe integer")
	}
	return int64(n)
}

func draftVersion(r *http.Request) int64 {
	version, err := strconv.ParseInt(r.PathValue("version"), 10, 64)
	if err != nil || version < 1 || version > 9007199254740991 {
		Raise("invalid_input", "A positive draft version is required")
	}
	return version
}

func (app *GraphApp) serveWorkDraftCreate(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	proposal, ok := body["proposal"].(map[string]any)
	if !ok {
		Raise("invalid_input", "A proposal object is required")
	}
	input := WorkDraftInput{WorkRevision: draftPositiveInteger(body["workRevision"], "workRevision"), Proposal: proposal}
	if value, exists := body["expectedDraftRevision"]; exists {
		revision := draftPositiveInteger(value, "expectedDraftRevision")
		input.ExpectedDraftRevision = &revision
	}
	if value, exists := body["newVersion"]; exists {
		newVersion, valid := value.(bool)
		if !valid {
			Raise("invalid_input", "newVersion must be a boolean")
		}
		input.NewVersion = newVersion
	}
	writeJSON(w, http.StatusOK, app.runtime.PutWorkDraft(r.PathValue("workId"), input, appBodyString(body, "requestId")))
}

func (app *GraphApp) serveWorkDrafts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": app.runtime.store.WorkDrafts(r.PathValue("workId"), appQueryBool(r, "archived"))})
}

func (app *GraphApp) serveWorkDraft(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.store.WorkDraft(r.PathValue("workId"), draftVersion(r)))
}

func (app *GraphApp) serveWorkDraftAction(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := WorkDraftAction{Version: draftVersion(r), Action: r.PathValue("action"),
		ExpectedDraftRevision: draftPositiveInteger(body["expectedDraftRevision"], "expectedDraftRevision")}
	writeJSON(w, http.StatusOK, app.runtime.ChangeWorkDraft(r.PathValue("workId"), input, appBodyString(body, "requestId")))
}
