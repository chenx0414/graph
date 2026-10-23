package graph

import (
	"net/http"
	"os"
	"strconv"
)

// serveTaskArtifacts is the artifact list of one task.
func (app *GraphApp) serveTaskArtifacts(w http.ResponseWriter, r *http.Request) {
	query := appArtifactQuery(r)
	query.TaskId = r.PathValue("taskId")
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().List(query))
}

// serveProjectArtifacts is the artifact list of one project.
func (app *GraphApp) serveProjectArtifacts(w http.ResponseWriter, r *http.Request) {
	query := appArtifactQuery(r)
	query.IncludeTaskArtifacts = r.URL.Query().Get("include") == "task"
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().ListProject(r.PathValue("projectId"), query))
}

// serveArtifact is one artifact record.
func (app *GraphApp) serveArtifact(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	if scope != "" && scope != "task" && scope != "project" {
		Raise("invalid_artifact", "scope must be task or project")
	}
	var version *int
	if raw := r.URL.Query().Get("version"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			Raise("invalid_input", "version must be a number")
		}
		version = &value
	}
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().Get(r.PathValue("taskId"), r.PathValue("artifactId"), version, scope))
}

// serveArtifactContent is the content of one artifact version.
func (app *GraphApp) serveArtifactContent(w http.ResponseWriter, r *http.Request) {
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		Raise("invalid_input", "version must be a number")
	}
	scope := r.URL.Query().Get("scope")
	if scope != "task" && scope != "project" {
		scope = ""
	}
	result := app.runtime.Artifacts().Read(r.PathValue("taskId"), r.PathValue("artifactId"), version, 262_144, scope)
	if r.URL.Query().Get("download") == "true" {
		raw, err := os.ReadFile(result.Path)
		if err != nil {
			panic(err)
		}
		w.Header().Set("content-disposition", "attachment; filename=\""+result.Record.Name+"\"")
		w.Header().Set("Content-Type", result.Record.MediaType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"artifact": result.Record, "text": result.Text, "truncated": result.Truncated,
		"bytes": result.Bytes, "events": result.Events,
	})
}

// serveArtifactRetire retires one artifact version.
func (app *GraphApp) serveArtifactRetire(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	reason, reasonOK := body["reason"].(string)
	requestID, requestOK := body["requestId"].(string)
	if !reasonOK || !requestOK {
		Raise("invalid_input", "reason and requestId are required")
	}
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		Raise("invalid_input", "version must be a number")
	}
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().Retire(
		r.PathValue("taskId"), r.PathValue("artifactId"), version, reason, requestID, nil))
}

// serveArtifactPromote promotes one artifact version.
func (app *GraphApp) serveArtifactPromote(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	requestID, ok := body["requestId"].(string)
	if !ok {
		Raise("invalid_input", "requestId is required")
	}
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		Raise("invalid_input", "version must be a number")
	}
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().Promote(ArtifactPromoteInput{
		TaskId: r.PathValue("taskId"), ArtifactId: r.PathValue("artifactId"),
		Version: version, RequestId: requestID,
	}))
}
