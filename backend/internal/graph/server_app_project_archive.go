package graph

import "net/http"

func (app *GraphApp) serveProjectLifecycle(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ProjectLifecycle(r.PathValue("projectId")))
}
func (app *GraphApp) serveProjectArchive(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.ArchiveProject(r.PathValue("projectId"), appBodyString(body, "requestId")))
}
func (app *GraphApp) serveProjectRestore(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.RestoreProject(r.PathValue("projectId"), appBodyString(body, "requestId")))
}
func (app *GraphApp) serveWorkResume(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.ResumeWork(r.PathValue("workId"), appBodyString(body, "requestId")))
}
