package graph

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"context"
)

type DaemonOptions struct {
	ConfigPath  *string
	StateDir    string
	GraphHome   string
	Port        int
	Mode        string
	Env         map[string]string
	Log         func(string)
	Dynamic     bool
	PresetsDir  string
	PriceVerify func(PriceSnapshot) bool
}

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

type GraphDaemon struct {
	URL               string
	StateDir          string
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

func (daemon *GraphDaemon) ApplyConfig(document any, expectedRevision int) ApplyConfigResult {
	return daemon.applyConfig(document, expectedRevision)
}

func (daemon *GraphDaemon) PushSecret(ref string, value *string, persisted ...bool) ApplyConfigResult {
	return daemon.pushSecret(ref, value, persisted...)
}

func (daemon *GraphDaemon) RefreshPrices(expectedRevision int) ApplyConfigResult {
	return daemon.refreshPrices(expectedRevision)
}

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

func priceVerifierFor(env map[string]string) func(PriceSnapshot) bool {
	source := ""
	if env != nil {
		source = strings.TrimSpace(env["GRAPH_PRICE_SOURCE_URL"])
	}
	if source == "" {
		return defaultPriceVerify
	}
	return func(snapshot PriceSnapshot) bool {
		return verifyPricePage(source, snapshot.ModelId)
	}
}

func verifyPricePage(sourceUrl string, modelId string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceUrl, nil)
	if err != nil {
		return false
	}
	request.Header.Set("user-agent", "graph-price-refresh/1")
	response, err := HTTPClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return false
	}
	return strings.Contains(string(body), modelId)
}
