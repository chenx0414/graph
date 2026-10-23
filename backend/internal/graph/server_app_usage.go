package graph

import (
	"net/http"
	"strings"
)

// serveUsage is the cached usage snapshot.
func (app *GraphApp) serveUsage(w http.ResponseWriter, r *http.Request) {
	service := app.appUsageService()
	if service == nil {
		writeJSON(w, http.StatusOK, UsageSnapshot{})
		return
	}
	snapshot, err := service.Get(false)
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// serveUsageRefresh forces a new usage snapshot.
func (app *GraphApp) serveUsageRefresh(w http.ResponseWriter, r *http.Request) {
	service := app.appUsageService()
	if service == nil {
		writeJSON(w, http.StatusOK, UsageSnapshot{})
		return
	}
	snapshot, err := service.Get(true)
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// serveUsageCredentials is the detected subscription credential map.
func (app *GraphApp) serveUsageCredentials(w http.ResponseWriter, r *http.Request) {
	service := app.appUsageService()
	if service == nil {
		writeJSON(w, http.StatusOK, appUsageCredentials{Credentials: map[string]string{}})
		return
	}
	credentials, err := service.Credentials()
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, appUsageCredentials{Credentials: credentials})
}

// serveModelPricing is the local price table.
func (app *GraphApp) serveModelPricing(w http.ResponseWriter, r *http.Request) {
	service := app.appUsageService()
	if service == nil {
		writeJSON(w, http.StatusOK, ModelPricingSnapshot{Source: "~/.cc-switch/model-pricing.json", UpdatedAt: nil, Models: []ModelPrice{}})
		return
	}
	pricing, err := service.Pricing()
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, pricing)
}

// serveProviders is the provider directory.
func (app *GraphApp) serveProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.appProvidersView())
}

// serveProviderProbe probes one unsaved provider draft.
func (app *GraphApp) serveProviderProbe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.appRunProviderProbe(appJSONBody(w, r)))
}

func (app *GraphApp) serveProviderLogin(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.loginService().start(rsiText(body["providerId"]), rsiText(body["credentialRef"])))
}
func (app *GraphApp) serveProviderLoginStatus(w http.ResponseWriter, r *http.Request) {
	service := app.loginService()
	writeJSON(w, http.StatusOK, service.view(service.get(r.PathValue("id"))))
}
func (app *GraphApp) serveProviderLoginCancel(w http.ResponseWriter, r *http.Request) {
	service := app.loginService()
	login := service.get(r.PathValue("id"))
	service.cancel(login)
	writeJSON(w, http.StatusOK, service.view(login))
}
func (app *GraphApp) serveProviderDisconnect(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.loginService().disconnect(rsiText(body["credentialRef"])))
}

// serveAppSecret stores one secret the desktop app pushed.
func (app *GraphApp) serveAppSecret(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil {
		Raise("invalid_config", "The daemon was started without the app bridge")
	}
	body := appJSONBody(w, r)
	ref, ok := body["ref"].(string)
	if !ok {
		Raise("invalid_input", "secretRef is required")
	}
	var value *string
	if raw, present := body["value"]; present && raw != nil {
		text, isText := raw.(string)
		if !isText {
			Raise("invalid_input", "The secret value must be a string or null")
		}
		value = &text
	}
	var persisted *bool
	if flag, isBool := body["persisted"].(bool); isBool {
		persisted = &flag
	}
	writeJSON(w, http.StatusOK, app.options.AppServices.PushSecret(ref, value, persisted))
}

// serveAppSecretRequests lists the secret writes the desktop app must store.
func (app *GraphApp) serveAppSecretRequests(w http.ResponseWriter, r *http.Request) {
	requests := []SecretPersistRequest{}
	if app.options.AppServices != nil {
		requests = app.options.AppServices.PendingSecretRequests()
	}
	writeJSON(w, http.StatusOK, appSecretRequests{Requests: requests})
}

// serveAppRsiStatus is the restart queue of the desktop app.
func (app *GraphApp) serveAppRsiStatus(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil || app.options.AppServices.Rsi == nil {
		writeJSON(w, http.StatusOK, appRsiUnavailable{Available: false, PendingRestart: nil, CanRestart: false})
		return
	}
	writeJSON(w, http.StatusOK, app.options.AppServices.Rsi.Status(r.URL.Query().Get("compare") == "1"))
}

// serveAppRsiRestartAck acknowledges one restart request.
func (app *GraphApp) serveAppRsiRestartAck(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil || app.options.AppServices.Rsi == nil {
		Raise("invalid_config", "The daemon was started without the app bridge")
	}
	body := appJSONBody(w, r)
	id, ok := body["id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		Raise("invalid_input", "A restart request id is required")
	}
	writeJSON(w, http.StatusOK, app.options.AppServices.Rsi.Ack(strings.TrimSpace(id)))
}

// serveLimits is the model limit table.
func (app *GraphApp) serveLimits(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ModelLimits())
}

// serveToolStats is the recorded tool-call telemetry.
func (app *GraphApp) serveToolStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ToolCallStats())
}

// serveToolStatsClear drops the recorded tool calls.
func (app *GraphApp) serveToolStatsClear(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ClearToolCalls())
}

// serveSkillStats is the skill telemetry.
func (app *GraphApp) serveSkillStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.SkillStats())
}

// serveSkillPromote promotes one project skill into the capability library.
func (app *GraphApp) serveSkillPromote(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	skillID, ok := body["skillId"].(string)
	if !ok || strings.TrimSpace(skillID) == "" {
		Raise("invalid_input", "skillId is required")
	}
	writeJSON(w, http.StatusOK, app.runtime.PromoteSkill(strings.TrimSpace(skillID)))
}
