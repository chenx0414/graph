package graph

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"bytes"
)

func appReadBody(w http.ResponseWriter, r *http.Request) []byte {
	limited := http.MaxBytesReader(w, r.Body, appBodyLimit)
	raw, err := io.ReadAll(limited)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			RaiseStatus(http.StatusRequestEntityTooLarge, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
		}
		panic(err)
	}
	return raw
}

func appJSONBody(w http.ResponseWriter, r *http.Request) map[string]any {
	raw := appReadBody(w, r)
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]any{}
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		RaiseStatus(http.StatusBadRequest, "FST_ERR_CTP_INVALID_JSON", "Body is not valid JSON")
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		RaiseStatus(http.StatusBadRequest, "FST_ERR_CTP_INVALID_JSON", "Body must be a JSON object")
	}
	return record
}

func appBodyString(body map[string]any, field string) string {
	value, _ := body[field].(string)
	return value
}

func appBodyInt(body map[string]any, field string) (int, bool) {
	value, ok := body[field].(float64)
	if !ok {
		return 0, false
	}
	return int(value), true
}

func appQueryNumber(r *http.Request, field string) (float64, bool) {
	raw := r.URL.Query().Get(field)
	if raw == "" {
		return 0, false
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

func appQueryInt(r *http.Request, field string) (int, bool) {
	value, ok := appQueryNumber(r, field)
	if !ok {
		return 0, false
	}
	return int(value), true
}

func appQueryBool(r *http.Request, field string) bool {
	return r.URL.Query().Get(field) == "true"
}

func appEventCursor(r *http.Request) int {
	raw := r.URL.Query().Get("after")
	if raw == "" {
		return 0
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		Raise("invalid_cursor", "Invalid event cursor")
	}
	return value
}

func (app *GraphApp) appConfigStore() *ConfigStore {
	return app.options.ConfigStore
}

func (app *GraphApp) appUsageService() UsageService {
	return app.options.Usage
}

func (app *GraphApp) appAgentContextLibrary() *AgentContextLibrary {
	return app.options.AgentContext
}

func (app *GraphApp) appConfigEnv() map[string]string {
	env := map[string]string{}
	for key, value := range app.options.ConfigEnv {
		if value != nil {
			env[key] = *value
		}
	}
	return env
}

func (app *GraphApp) appProviderSecrets() map[string]string {
	if app.options.AppServices != nil && app.options.AppServices.CapabilityConfig != nil {
		return app.options.AppServices.CapabilityConfig.SecretValues()
	}
	return app.appConfigEnv()
}

func (app *GraphApp) appProvidersView() map[string]any {
	secrets := app.appProviderSecrets()
	credentials := map[string]ProviderCredentialView{}
	if store := app.appConfigStore(); store != nil {
		view, ok := app.recoverValue(func() any { return SanitizeProviderView(store.Snapshot().Config, secrets) })
		if ok {
			credentials = view.(ProviderView).Credentials
		}
	}
	if app.logins != nil {
		for id, credential := range credentials {
			state, known := app.logins.xaiRefreshStatus(credential.SecretRef)
			if !known {
				continue
			}
			credential.NeedsRelogin = state.NeedsRelogin
			credential.CredentialNote = state.Reason
			credentials[id] = credential
		}
	}
	return map[string]any{
		"platforms":   PlatformCatalogView(secrets).Platforms,
		"credentials": credentials,
	}
}
