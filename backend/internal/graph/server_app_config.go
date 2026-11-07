package graph

import (
	"net/http"
	"os"
	"strings"
)

func (app *GraphApp) serveConfig(w http.ResponseWriter, r *http.Request) {
	store := app.appConfigStore()
	if store == nil {
		Raise("invalid_config", "The daemon was started without a configuration file")
	}
	snapshot := store.Snapshot()
	view := appConfigView{
		Revision:          snapshot.Revision,
		Config:            SanitizeConfig(snapshot.Config, app.appProviderSecrets()),
		PendingSecretRefs: []string{},
		Watch:             nil,
	}
	if app.options.AppServices != nil {
		if status, ok := app.options.AppServices.Snapshot().(ApplyConfigResult); ok {
			revision := status.EffectiveRevision
			configured := status.Configured
			view.EffectiveRevision = &revision
			view.Configured = &configured
		}
		for _, request := range app.options.AppServices.PendingSecretRequests() {
			view.PendingSecretRefs = append(view.PendingSecretRefs, request.Ref)
		}
		if report := app.options.AppServices.ConfigWatch(); report != nil {
			view.Watch = &appConfigWatch{
				Watching: report.Watching, Events: report.Events, Applied: report.Applied,
				Ignored: report.Ignored, LastEventAt: report.LastEventAt, LastReason: report.LastReason,
				FileRevision: report.FileRevision,
			}
		}
	}
	writeJSON(w, http.StatusOK, view)
}

func (app *GraphApp) serveConfigSave(w http.ResponseWriter, r *http.Request) {
	store := app.appConfigStore()
	if store == nil {
		Raise("invalid_config", "The daemon was started without a configuration file")
	}
	body := appJSONBody(w, r)
	expectedRevision, ok := appBodyInt(body, "expectedRevision")
	if !ok || expectedRevision < 0 {
		Raise("invalid_input", "expectedRevision must be a nonnegative integer")
	}
	document := body["document"]
	current := store.Snapshot()
	nextIDs := map[string]bool{}
	if entries, ok := appDocumentModelIDs(document); ok {
		nextIDs = entries
	}
	currentIDs := map[string]bool{}
	if current.Config.Models != nil {
		for _, entry := range current.Config.Models.Entries {
			currentIDs[entry.Id] = true
		}
	}
	removed := []string{}
	for _, id := range app.runtime.ModelsInUse() {
		if currentIDs[id] && !nextIDs[id] {
			removed = append(removed, id)
		}
	}
	if len(removed) > 0 {
		Raise("config_in_use", "Models in use by unfinished tasks cannot be removed: "+strings.Join(removed, ", "))
	}
	if app.options.AppServices != nil {
		applied, ok := app.options.AppServices.ApplyConfig(document, expectedRevision).(ApplyConfigResult)
		if !ok {
			Raise("internal", "The configuration apply returned no result")
		}
		writeJSON(w, http.StatusOK, appApplyResultOf(applied, false))
		return
	}
	saved := store.Save(document, expectedRevision, app.appConfigEnv(), nil)
	writeJSON(w, http.StatusOK, appConfigSaveResult{
		Revision: saved.Revision, RestartRequired: current.Revision != saved.Revision,
	})
}

func appDocumentModelIDs(document any) (map[string]bool, bool) {
	record, ok := document.(map[string]any)
	if !ok {
		return map[string]bool{}, false
	}
	models, ok := record["models"].(map[string]any)
	if !ok {
		return map[string]bool{}, false
	}
	entries, ok := models["entries"].([]any)
	if !ok {
		return map[string]bool{}, false
	}
	ids := map[string]bool{}
	for _, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		id, _ := item["id"].(string)
		ids[id] = true
	}
	return ids, true
}

func (app *GraphApp) servePricingRefresh(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil || app.options.AppServices.RefreshPrices == nil {
		Raise("invalid_config", "The daemon was started without the app bridge")
	}
	body := appJSONBody(w, r)
	expectedRevision, ok := appBodyInt(body, "expectedRevision")
	if !ok || expectedRevision < 0 {
		Raise("invalid_input", "expectedRevision must be a nonnegative integer")
	}
	refreshed, ok := app.options.AppServices.RefreshPrices(expectedRevision).(ApplyConfigResult)
	if !ok {
		Raise("internal", "The price refresh returned no result")
	}
	writeJSON(w, http.StatusOK, appApplyResultOf(refreshed, false))
}

func (app *GraphApp) serveConfigTest(w http.ResponseWriter, r *http.Request) {
	if app.options.ConfigTest == nil {
		Raise("invalid_config", "The daemon was started without a configuration file")
	}
	body := appJSONBody(w, r)
	modelID, ok := body["modelId"].(string)
	if !ok || strings.TrimSpace(modelID) == "" {
		Raise("invalid_input", "modelId is required")
	}
	writeJSON(w, http.StatusOK, app.options.ConfigTest(strings.TrimSpace(modelID)))
}

func (app *GraphApp) serveSettings(w http.ResponseWriter, r *http.Request) {
	catalog := app.runtime.Catalog()
	capabilities := catalog.CapabilitiesView()
	view := appSettingsView{
		Projects:              app.runtime.User().Projects(),
		Models:                app.runtime.Models(),
		DefaultModel:          app.runtime.DefaultModel(),
		Definitions:           appDefinitionSummaries(catalog.ListDefinitions()),
		Capabilities:          capabilities,
		CapabilityConfig:      CapabilityConfigViews(capabilities, app.appCapabilitySecrets()),
		AgentCombinations:     catalog.AgentCombinations(),
		CapabilityRoot:        appOptionalString(catalog.CapabilityRootPath()),
		AgentCombinationFile:  appOptionalString(catalog.AgentCombinationFilePath()),
		AgentCombinationError: catalog.AgentCombinationError(),
	}
	writeJSON(w, http.StatusOK, view)
}

func (app *GraphApp) appCapabilitySecrets() map[string]string {
	if app.options.AppServices != nil && app.options.AppServices.CapabilityConfig != nil {
		return app.options.AppServices.CapabilityConfig.SecretValues()
	}
	secrets := map[string]string{}
	for _, entry := range os.Environ() {
		name, secret, ok := strings.Cut(entry, "=")
		if !ok || strings.TrimSpace(secret) == "" {
			continue
		}
		secrets[name] = secret
	}
	return secrets
}

type appDefinitionSummary struct {
	ID      string `json:"id"`
	Version int64  `json:"version"`
}

func appDefinitionSummaries(definitions []struct {
	Id      string
	Version int64
}) []appDefinitionSummary {
	summaries := make([]appDefinitionSummary, 0, len(definitions))
	for _, definition := range definitions {
		summaries = append(summaries, appDefinitionSummary{ID: definition.Id, Version: definition.Version})
	}
	return summaries
}

func appOptionalString(value string) *string {
	if value == "" {
		return nil
	}
	copied := value
	return &copied
}

func (app *GraphApp) serveCapabilityConfig(w http.ResponseWriter, r *http.Request) {
	items := CapabilityConfigViews(app.runtime.Catalog().Capabilities(), app.appCapabilitySecrets())
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
