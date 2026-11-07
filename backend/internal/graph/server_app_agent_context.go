package graph

import (
	"net/http"
)

func (app *GraphApp) appAgentContextPreview(conversationID string) any {
	var id *string
	if conversationID != "" {
		copied := conversationID
		id = &copied
	}
	return app.runtime.AgentContextPreview(id)
}

func (app *GraphApp) serveAgentContext(w http.ResponseWriter, r *http.Request) {
	conversationID := r.URL.Query().Get("conversationId")
	writeJSON(w, http.StatusOK, app.appAgentContextPreview(conversationID))
}

func (app *GraphApp) serveAgentContextPrompt(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	key, keyOK := body["key"].(string)
	content, contentOK := body["content"].(string)
	if !keyOK || !contentOK {
		Raise("invalid_input", "key and content are required")
	}
	library.SavePrompt(key, content)
	writeJSON(w, http.StatusOK, library.View(nil))
}

func (app *GraphApp) serveAgentContextDefault(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	key, keyOK := body["key"].(string)
	content, contentOK := body["content"].(string)
	if !keyOK || !contentOK {
		Raise("invalid_input", "key and content are required")
	}
	library.SetPromptDefault(key, content)
	writeJSON(w, http.StatusOK, library.View(nil))
}

func (app *GraphApp) serveAgentContextDefaultReset(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	key, ok := body["key"].(string)
	if !ok {
		Raise("invalid_input", "key is required")
	}
	library.ClearPromptDefault(key)
	writeJSON(w, http.StatusOK, library.View(nil))
}

func (app *GraphApp) serveAgentContextPromptReset(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	key, ok := body["key"].(string)
	if !ok {
		Raise("invalid_input", "key is required")
	}
	library.ResetPrompt(key)
	writeJSON(w, http.StatusOK, library.View(nil))
}

func (app *GraphApp) serveAgentContextTools(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	raw, ok := body["disabled"].([]any)
	if !ok {
		Raise("invalid_input", "disabled must be a string array")
	}
	disabled := []string{}
	for _, item := range raw {
		name, isText := item.(string)
		if !isText {
			Raise("invalid_input", "disabled must be a string array")
		}
		disabled = append(disabled, name)
	}
	writeJSON(w, http.StatusOK, appDisabledTools{DisabledTools: library.SetDisabledTools(disabled)})
}
