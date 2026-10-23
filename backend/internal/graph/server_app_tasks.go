package graph

import (
	"bytes"
	"encoding/json"
	"net/http"
)

// serveTaskCreate starts one task.
func (app *GraphApp) serveTaskCreate(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := TaskRuntimeBeginInput{
		ProjectId: appBodyString(body, "projectId"),
		Request:   appBodyString(body, "request"),
		RequestId: appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.User().Begin(input))
}

// serveTask is one task view.
func (app *GraphApp) serveTask(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.User().Task(r.PathValue("taskId")).View())
}

// serveTaskSay adds one message to a task.
func (app *GraphApp) serveTaskSay(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Say(appBodyString(body, "text"), appBodyString(body, "requestId")))
}

// serveTaskAccept confirms the proposal of a task.
func (app *GraphApp) serveTaskAccept(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	draftRevision, _ := appBodyInt(body, "draftRevision")
	input := TaskRuntimeAcceptInput{
		ProposalVersion: proposalVersion,
		DraftRevision:   draftRevision,
		TargetBranch:    appBodyString(body, "targetBranch"),
		RequestId:       appBodyString(body, "requestId"),
	}
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Accept(input))
}

// serveTaskAbandon abandons one task.
func (app *GraphApp) serveTaskAbandon(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	var reason *string
	if value, ok := body["reason"].(string); ok {
		reason = &value
	}
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Abandon(appBodyString(body, "requestId"), reason))
}

// serveTaskPause pauses one task.
func (app *GraphApp) serveTaskPause(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Pause(appBodyString(body, "requestId")))
}

// serveTaskResume resumes one task.
func (app *GraphApp) serveTaskResume(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Resume(appBodyString(body, "requestId")))
}

// serveTaskBudget changes the budget of one node.
func (app *GraphApp) serveTaskBudget(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := TaskRuntimeBudgetInput{
		NodeId:    appBodyString(body, "nodeId"),
		RequestId: appBodyString(body, "requestId"),
	}
	if raw, present := body["tokens"]; present && raw != nil {
		value, ok := raw.(float64)
		if !ok {
			Raise("invalid_input", "tokens must be a number or null")
		}
		tokens := int64(value)
		input.Tokens = &tokens
	}
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.SetBudget(input))
}

// serveTaskAnswer answers one open question.
func (app *GraphApp) serveTaskAnswer(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	answer := Answer{}
	if raw, ok := body["answer"].(map[string]any); ok {
		if value, ok := raw["type"].(string); ok {
			answer.Type = value
		}
		if value, ok := raw["tokens"].(float64); ok {
			answer.Tokens = int64(value)
		}
		if value, ok := raw["value"]; ok {
			answer.Value = value
		}
		if value, ok := raw["grant"].(string); ok {
			answer.Grant = value
		}
		if value, ok := raw["reason"].(string); ok {
			answer.Reason = &value
		}
		if value, ok := raw["proof"].(string); ok {
			answer.Proof = value
		}
	}
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Answer(appBodyString(body, "questionId"), answer, appBodyString(body, "requestId")))
}

// serveTaskEvents is the event page of one task.
func (app *GraphApp) serveTaskEvents(w http.ResponseWriter, r *http.Request) {
	after := 0
	if value, ok := appQueryInt(r, "after"); ok {
		after = value
	}
	limit := 200
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	writeJSON(w, http.StatusOK, app.runtime.Events(r.PathValue("taskId"), after, limit))
}

// serveTaskStream is the event stream of one task.
func (app *GraphApp) serveTaskStream(w http.ResponseWriter, r *http.Request) {
	after := appEventCursor(r)
	task := app.runtime.User().Task(r.PathValue("taskId"))
	app.appWriteEventStream(w, r, task.Watch(after))
}

// appWriteEventStream writes the SSE frames of one watch. The headers are
// flushed before the first event; every event is one `data: <json>\n\n` frame.
func (app *GraphApp) appWriteEventStream(w http.ResponseWriter, r *http.Request, watch TaskWatch) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	if watch.Next == nil {
		return
	}
	// A client disconnect must end the server-side watch, or the daemon
	// shutdown would wait on a stream nobody can consume.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-r.Context().Done():
			if watch.Stop != nil {
				watch.Stop()
			}
		case <-done:
		}
	}()
	for {
		if r.Context().Err() != nil {
			return
		}
		update, ok := watch.Next()
		if !ok {
			return
		}
		raw, err := appJSONBytes(update)
		if err != nil {
			panic(err)
		}
		if _, err := w.Write([]byte("data: ")); err != nil {
			return
		}
		if _, err := w.Write(raw); err != nil {
			return
		}
		if _, err := w.Write([]byte("\n\n")); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
}

// appJSONBytes encodes a value the way JSON.stringify does.
func appJSONBytes(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}
