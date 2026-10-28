package graph

import "net/http"

func (app *GraphApp) serveGlobalThread(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.EnsureGlobalThread(appBodyString(body, "requestId")))
}

func (app *GraphApp) serveProjectThread(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.OpenProjectThread(r.PathValue("projectId"), appBodyString(body, "requestId")))
}

func (app *GraphApp) serveProjectThreadSelection(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.SelectProjectThread(r.PathValue("projectId"), appBodyString(body, "conversationId"), appBodyString(body, "requestId")))
}

func (app *GraphApp) serveProjectThreadPreview(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.PreviewProjectThread(r.PathValue("projectId"), r.URL.Query().Get("conversationId")))
}
