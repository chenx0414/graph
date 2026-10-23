package graph

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
)

// appReadBody reads the request body under the 24 MiB JSON limit.
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

// appJSONBody reads and parses the JSON body of one request.
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

// appBodyString reads a string field of the JSON body.
func appBodyString(body map[string]any, field string) string {
	value, _ := body[field].(string)
	return value
}

// appBodyInt reads an integer field of the JSON body.
func appBodyInt(body map[string]any, field string) (int, bool) {
	value, ok := body[field].(float64)
	if !ok {
		return 0, false
	}
	return int(value), true
}

// appQueryNumber reads a numeric query parameter.
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

// appQueryInt reads an integer query parameter.
func appQueryInt(r *http.Request, field string) (int, bool) {
	value, ok := appQueryNumber(r, field)
	if !ok {
		return 0, false
	}
	return int(value), true
}

// appQueryBool reads a boolean query parameter.
func appQueryBool(r *http.Request, field string) bool {
	return r.URL.Query().Get(field) == "true"
}

// appEventCursor reads the after cursor of an event stream.
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

// appConfigStore is the configuration store the console reads and writes.
func (app *GraphApp) appConfigStore() *ConfigStore {
	return app.options.ConfigStore
}

// appUsageService is the subscription-usage service the console reads.
func (app *GraphApp) appUsageService() UsageService {
	return app.options.Usage
}

// appAgentContextLibrary is the prompt library the console edits.
func (app *GraphApp) appAgentContextLibrary() *AgentContextLibrary {
	return app.options.AgentContext
}

// appConfigEnv is the environment the configuration store resolves secrets in.
func (app *GraphApp) appConfigEnv() map[string]string {
	env := map[string]string{}
	for key, value := range app.options.ConfigEnv {
		if value != nil {
			env[key] = *value
		}
	}
	return env
}

// appProviderSecrets is the merged secret view the provider directory reads.
// The runtime's merged view is authoritative: it already drops revoked refs
// even when the process environment still names the variable.
func (app *GraphApp) appProviderSecrets() map[string]string {
	if app.options.AppServices != nil && app.options.AppServices.CapabilityConfig != nil {
		return app.options.AppServices.CapabilityConfig.SecretValues()
	}
	return app.appConfigEnv()
}

// appProvidersView is the provider directory and the credential view.
func (app *GraphApp) appProvidersView() map[string]any {
	secrets := app.appProviderSecrets()
	credentials := map[string]ProviderCredentialView{}
	if store := app.appConfigStore(); store != nil {
		view, ok := app.recoverValue(func() any { return SanitizeProviderView(store.Snapshot().Config, secrets) })
		if ok {
			credentials = view.(ProviderView).Credentials
		}
	}
	return map[string]any{
		"platforms":   PlatformCatalogView(secrets).Platforms,
		"credentials": credentials,
	}
}
