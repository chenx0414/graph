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
