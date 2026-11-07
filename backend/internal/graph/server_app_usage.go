package graph

import (
	"net/http"
	"strings"
)

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

func (app *GraphApp) serveProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.appProvidersView())
}

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

func (app *GraphApp) serveAppSecretRequests(w http.ResponseWriter, r *http.Request) {
	requests := []SecretPersistRequest{}
	if app.options.AppServices != nil {
		requests = app.options.AppServices.PendingSecretRequests()
	}
	writeJSON(w, http.StatusOK, appSecretRequests{Requests: requests})
}

func (app *GraphApp) serveAppRsiStatus(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil || app.options.AppServices.Rsi == nil {
		writeJSON(w, http.StatusOK, appRsiUnavailable{Available: false, PendingRestart: nil, CanRestart: false})
		return
	}
	writeJSON(w, http.StatusOK, app.options.AppServices.Rsi.Status(r.URL.Query().Get("compare") == "1"))
}

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

func (app *GraphApp) serveLimits(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ModelLimits())
}

func (app *GraphApp) serveToolStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ToolCallStats())
}

func (app *GraphApp) serveToolStatsClear(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ClearToolCalls())
}

func (app *GraphApp) serveSkillStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.SkillStats())
}

func (app *GraphApp) serveSkillPromote(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	skillID, ok := body["skillId"].(string)
	if !ok || strings.TrimSpace(skillID) == "" {
		Raise("invalid_input", "skillId is required")
	}
	writeJSON(w, http.StatusOK, app.runtime.PromoteSkill(strings.TrimSpace(skillID)))
}
