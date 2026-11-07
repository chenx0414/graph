package graph

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

func (app *GraphApp) serveCatalog(w http.ResponseWriter, r *http.Request) {
	catalog := app.runtime.Catalog()
	writeJSON(w, http.StatusOK, appCatalogView{
		Definitions:           appDefinitionSummaries(catalog.ListDefinitions()),
		Capabilities:          catalog.Capabilities(),
		AgentCombinations:     catalog.AgentCombinations(),
		CapabilityRoot:        appOptionalString(catalog.CapabilityRootPath()),
		AgentCombinationFile:  appOptionalString(catalog.AgentCombinationFilePath()),
		AgentCombinationError: catalog.AgentCombinationError(),
	})
}

func (app *GraphApp) serveCatalogRefresh(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().Refresh())
}

func (app *GraphApp) serveExtensionsReload(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	deferred, _ := body["deferred"].(bool)
	writeJSON(w, http.StatusOK, app.runtime.ReloadExtensions(appBodyString(body, "requestId"), deferred))
}

func (app *GraphApp) serveExtensionsStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ExtensionReloadStatus())
}

func (app *GraphApp) servePiExtensionUpdates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.PiExtensionUpdates())
}

func (app *GraphApp) servePiPackages(w http.ResponseWriter, r *http.Request) {
	input := struct {
		Query string
		Limit int
	}{}
	if query := strings.TrimSpace(r.URL.Query().Get("q")); query != "" {
		input.Query = query
	}
	if limit, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil {
		input.Limit = limit
	}
	writeJSON(w, http.StatusOK, map[string]any{"packages": SearchPiPackages(input)})
}

func (app *GraphApp) servePiExtensionUpdate(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.UpdatePiExtension(r.PathValue("id"), r.PathValue("version")))
}

func (app *GraphApp) serveCombinationSave(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	raw, ok := body["combination"]
	if !ok || raw == nil {
		Raise("invalid_input", "combination is required")
	}
	combination, err := appAgentCombination(raw)
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, app.runtime.Catalog().SaveAgentCombination(combination))
}

func appAgentCombination(value any) (AgentCombination, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return AgentCombination{}, err
	}
	combination := AgentCombination{}
	if err := json.Unmarshal(raw, &combination); err != nil {
		return AgentCombination{}, err
	}
	return combination, nil
}

func (app *GraphApp) serveCombinationDescription(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	description, ok := body["description"].(string)
	if !ok {
		Raise("invalid_input", "description is required")
	}
	writeJSON(w, http.StatusOK, app.runtime.Catalog().UpdateAgentCombinationDescription(r.PathValue("id"), description))
}

func (app *GraphApp) serveCombinationDelete(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().DeleteAgentCombination(r.PathValue("id")))
}

func (app *GraphApp) serveCombinationCompile(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().CompileAgentCombination(r.PathValue("id")))
}

func (app *GraphApp) serveDefinition(w http.ResponseWriter, r *http.Request) {
	var version *int
	if raw := r.URL.Query().Get("version"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			Raise("invalid_input", "version must be a number")
		}
		version = &value
	}
	writeJSON(w, http.StatusOK, app.runtime.Talent(r.PathValue("definitionId"), version, r.URL.Query().Get("scope") == "all"))
}
