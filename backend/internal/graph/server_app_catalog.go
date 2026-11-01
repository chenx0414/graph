package graph

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// serveCatalog is the catalog page payload.
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

// serveCatalogRefresh rescans the capability library.
func (app *GraphApp) serveCatalogRefresh(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().Refresh())
}

// serveExtensionsReload replaces the daemon's Pi extension host, so the next
// session reads every extension's configuration again (a server installed while
// the app was running needs this).
func (app *GraphApp) serveExtensionsReload(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.ReloadExtensions(appBodyString(body, "requestId")))
}

// servePiExtensionUpdates lists the Pi extensions with a newer version.
func (app *GraphApp) servePiExtensionUpdates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.PiExtensionUpdates())
}

// servePiPackages browses the official Pi package channel.
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

// servePiExtensionUpdate installs or upgrades one Pi extension.
func (app *GraphApp) servePiExtensionUpdate(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.UpdatePiExtension(r.PathValue("id"), r.PathValue("version")))
}

// serveCombinationSave stores one agent combination.
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

// appAgentCombination reads one agent combination document.
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

// serveCombinationDescription renames one agent combination.
func (app *GraphApp) serveCombinationDescription(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	description, ok := body["description"].(string)
	if !ok {
		Raise("invalid_input", "description is required")
	}
	writeJSON(w, http.StatusOK, app.runtime.Catalog().UpdateAgentCombinationDescription(r.PathValue("id"), description))
}

// serveCombinationDelete removes one agent combination.
func (app *GraphApp) serveCombinationDelete(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().DeleteAgentCombination(r.PathValue("id")))
}

// serveCombinationCompile compiles one agent combination.
func (app *GraphApp) serveCombinationCompile(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().CompileAgentCombination(r.PathValue("id")))
}

// serveDefinition is the talent view of one definition.
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
