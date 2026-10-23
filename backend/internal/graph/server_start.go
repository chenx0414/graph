package graph

import (
	"fmt"
)

// DaemonOptions is the console process configuration.
type DaemonOptions struct {
	ConfigPath  *string
	StateDir    string
	WebDir      string
	GraphHome   string
	Port        int
	Mode        string
	Env         map[string]string
	Log         func(string)
	Dynamic     bool
	PresetsDir  string
	PriceVerify func(PriceSnapshot) bool
}

// ApplyConfigResult is one config or secret apply.
type ApplyConfigResult struct {
	Revision          int                  `json:"revision"`
	EffectiveRevision int                  `json:"effectiveRevision"`
	Applied           bool                 `json:"applied"`
	Reason            *string              `json:"reason"`
	Configured        bool                 `json:"configured"`
	ModelCount        int                  `json:"modelCount"`
	EnabledModelCount int                  `json:"enabledModelCount"`
	Results           []PriceRefreshResult `json:"results"`
}

// GraphDaemon is the running console.
type GraphDaemon struct {
	URL               string
	StateDir          string
	WebDir            string
	ConfigPath        *string
	Mode              string
	Configured        bool
	ModelCount        int
	EnabledModelCount int
	AppToken          string
	server            *GraphHost
	watch             *ConfigWatch
	applyConfig       func(any, int) ApplyConfigResult
	pushSecret        func(string, *string, ...bool) ApplyConfigResult
	refreshPrices     func(int) ApplyConfigResult
}

// ApplyConfig validates and activates one document.
func (daemon *GraphDaemon) ApplyConfig(document any, expectedRevision int) ApplyConfigResult {
	return daemon.applyConfig(document, expectedRevision)
}

// PushSecret applies one APP-supplied secret. A nil value revokes it.
func (daemon *GraphDaemon) PushSecret(ref string, value *string, persisted ...bool) ApplyConfigResult {
	return daemon.pushSecret(ref, value, persisted...)
}

// RefreshPrices re-verifies archived prices and activates the result.
func (daemon *GraphDaemon) RefreshPrices(expectedRevision int) ApplyConfigResult {
	return daemon.refreshPrices(expectedRevision)
}

// Close stops the HTTP server and the runtime it owns.
func (daemon *GraphDaemon) Close() {
	if daemon.watch != nil {
		daemon.watch.Stop()
	}
	if daemon.server != nil {
		daemon.server.Close()
	}
}

type providerGroup struct {
	baseURL      string
	credentialID string
	api          ModelApi
	entries      []ConfiguredModel
}

func providerGroups(entries []ConfiguredModel) map[string]*providerGroup {
	groups := map[string]*providerGroup{}
	order := []string{}
	for _, entry := range entries {
		group := groups[entry.Provider]
		if group == nil {
			group = &providerGroup{baseURL: entry.BaseUrl, credentialID: entry.CredentialId, api: entry.Api, entries: []ConfiguredModel{entry}}
			groups[entry.Provider] = group
			order = append(order, entry.Provider)
			continue
		}
		if group.baseURL != entry.BaseUrl {
			Raise("invalid_config", fmt.Sprintf("Models for provider %q must share one baseUrl", entry.Provider))
		}
		if group.credentialID != entry.CredentialId {
			Raise("invalid_config", fmt.Sprintf("Models for provider %q must share one credentialId", entry.Provider))
		}
		if group.api != entry.Api {
			Raise("invalid_config", fmt.Sprintf("Models for provider %q must share one api", entry.Provider))
		}
		group.entries = append(group.entries, entry)
	}
	_ = order
	return groups
}

func missingSecrets(config GraphConfig, entries []ConfiguredModel, env map[string]string) []string {
	missing := []string{}
	seen := map[string]bool{}
	envPtr := map[string]*string{}
	for key, value := range env {
		copied := value
		envPtr[key] = &copied
	}
	for _, group := range providerGroups(entries) {
		secret := ResolveCredentialSecret(config, group.credentialID, envPtr)
		if !secret.Configured && secret.SecretRef != "" && !seen[secret.SecretRef] {
			seen[secret.SecretRef] = true
			missing = append(missing, secret.SecretRef)
		}
	}
	return missing
}
