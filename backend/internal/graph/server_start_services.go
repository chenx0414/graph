package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func daemonTestConnection(live *LiveConfig, modelID string) map[string]any {
	var entry *ConfiguredModel
	for _, candidate := range live.Entries() {
		if candidate.Id == modelID {
			copied := candidate
			entry = &copied
			break
		}
	}
	if entry == nil {
		Raise("not_found", "Unknown model "+modelID)
	}
	binding := live.CredentialFor(*entry)
	if binding == nil {
		return map[string]any{"ok": false, "model": entry.Id, "credentialId": entry.CredentialId, "message": "Credential not configured: " + entry.CredentialId}
	}
	started := NowMillis()
	anthropic := entry.Api == "anthropic-messages"
	path := "/chat/completions"
	if anthropic {
		path = "/messages"
	}
	body := map[string]any{"model": entry.Id, "messages": []any{map[string]any{"role": "user", "content": "ping"}}, "max_tokens": 1, "stream": false}
	if entry.ModelId != "" {
		body["model"] = entry.ModelId
	}
	payload, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(entry.BaseUrl, "/")+path, strings.NewReader(string(payload)))
	if err != nil {
		return map[string]any{"ok": false, "model": entry.Id, "credentialId": entry.CredentialId, "latencyMs": NowMillis() - started, "message": err.Error()}
	}
	request.Header.Set("content-type", "application/json")
	if anthropic {
		request.Header.Set("x-api-key", binding.APIKey)
		request.Header.Set("anthropic-version", "2023-06-01")
	} else {
		request.Header.Set("authorization", "Bearer "+binding.APIKey)
	}
	for key, value := range ModelRequestHeaders(entry.ModelEntry) {
		request.Header.Set(key, value)
	}
	response, err := HTTPClient.Do(request)
	if err != nil {
		return map[string]any{"ok": false, "model": entry.Id, "credentialId": entry.CredentialId, "latencyMs": NowMillis() - started, "message": err.Error()}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	ok := response.StatusCode >= 200 && response.StatusCode < 300
	result := map[string]any{"ok": ok, "model": entry.Id, "credentialId": entry.CredentialId, "status": response.StatusCode, "latencyMs": NowMillis() - started}
	if !ok {
		result["message"] = fmt.Sprintf("HTTP %d", response.StatusCode)
	}
	return result
}

func daemonMasterDefinitionVersion(server *GraphHost, hasMain bool) string {
	if !hasMain {
		return "master@1"
	}
	catalog := runtimeCatalog(server)
	if catalog == nil {
		return "master@1"
	}
	for _, item := range catalog.ListDefinitions() {
		if item.Id == "main" {
			return "main@" + itoa(int(item.Version))
		}
	}
	return "master@1"
}

func daemonSystemSummary(live *LiveConfig, userHome string, agentContext *AgentContextLibrary, server *GraphHost, usage UsageService) any {
	inventory := SystemInventoryInput{
		Models: live.Entries(),
		CredentialConfigured: func(entry ConfiguredModel) bool {
			return live.CredentialFor(entry) != nil
		},
		Access:          live.Access(),
		Architectures:   GRAPH_ARCHITECTURES,
		CapabilityRoot:  filepath.Join(userHome, "capabilities"),
		ApplicationRoot: ApplicationRoot,
		ApplicationMode: "source",
		DocsRoot:        GraphDocumentationPathsOf(ApplicationRoot).Root,
	}
	if library := agentContext; library != nil {
		inventory.AgentContextRoot = library.Root
	}
	if catalog := runtimeCatalog(server); catalog != nil {
		inventory.Combinations = catalog.AgentCombinations()
		for _, item := range catalog.AvailableAgentDefinitions() {
			inventory.Definitions = append(inventory.Definitions, SystemDefinition{ID: item.Id, Version: item.Version})
		}
		inventory.Capabilities = catalog.Capabilities()
	}
	if snapshot, err := usage.Get(false); err == nil {
		inventory.Plans = snapshot.Plans
		inventory.Usage = snapshot.Summary
	}
	return SystemInventory(inventory)
}

func daemonSyncProviders(options DaemonOptions, live *LiveConfig, modelRuntime *ModelRuntime) {
	if !options.Dynamic && !live.Enabled() {
		return
	}
	for provider, group := range providerGroups(live.Entries()) {
		binding := live.CredentialFor(group.entries[0])
		if binding == nil {
			continue
		}
		modelRuntime.RegisterProvider(provider, ProviderRegistration{
			BaseURL: group.baseURL, API: group.api, APIKey: binding.APIKey, Models: append([]ConfiguredModel{}, group.entries...), Headers: ModelRequestHeaders(group.entries[0].ModelEntry),
		})
	}
}

func daemonRefreshPrices(options DaemonOptions, config GraphConfig, configured bool, applyNow func(any, int) ApplyConfigResult, expectedRevision int) ApplyConfigResult {
	if !configured || config.Path == nil {
		Raise("invalid_config", "The daemon was started without a configuration file")
	}
	raw, err := os.ReadFile(*config.Path)
	if err != nil {
		panic(err)
	}
	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		panic(err)
	}
	verify := options.PriceVerify
	if verify == nil {
		verify = priceVerifierFor(options.Env)
	}
	decisions := map[string]bool{}
	for _, snapshot := range PRICE_SNAPSHOT {
		decisions[snapshot.Provider+":"+snapshot.ModelId] = verify(snapshot)
	}
	retrievedAt := time.Now().UTC().Format("2006-01-02")
	refreshed, results := ApplyPriceSnapshot(document, func(snapshot PriceSnapshot) bool {
		return decisions[snapshot.Provider+":"+snapshot.ModelId]
	}, PRICE_SNAPSHOT_BASE+".refresh."+retrievedAt, retrievedAt)
	result := applyNow(refreshed, expectedRevision)
	result.Results = results
	if !result.Applied && result.Reason == nil {
		result.Reason = liveReason("refresh rejected")
	}
	return result
}

func daemonCapabilitySecrets(options DaemonOptions, live *LiveConfig) map[string]string {
	revoked := map[string]bool{}
	for _, ref := range live.Revoked() {
		revoked[ref] = true
	}
	values := map[string]string{}
	for ref, value := range options.Env {
		if revoked[ref] || strings.TrimSpace(value) == "" {
			continue
		}
		values[ref] = value
	}
	for ref, value := range live.Secrets() {
		if revoked[ref] || strings.TrimSpace(value) == "" {
			continue
		}
		values[ref] = value
	}
	return values
}
