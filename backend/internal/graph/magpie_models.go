package graph

import (
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const MAGPIE_CREDENTIAL_ID = "magpie"

type magpieGatewayModel struct {
	ID              string   `json:"id"`
	OwnedBy         string   `json:"owned_by"`
	DisplayName     string   `json:"display_name"`
	ContextWindow   int      `json:"context_window"`
	ContextLength   int      `json:"context_length"`
	MaxInputTokens  int      `json:"max_input_tokens"`
	MaxOutputTokens int      `json:"max_output_tokens"`
	MaxTokens       int      `json:"max_tokens"`
	Reasoning       bool     `json:"reasoning"`
	ReasoningLevels []string `json:"reasoning_levels"`
	Modalities      struct {
		Input []string `json:"input"`
	} `json:"modalities"`
}

func magpieAPIKey() string {
	if key := strings.TrimSpace(os.Getenv("MAGPIE_API_KEY")); key != "" {
		return key
	}
	return "magpie-local"
}

func magpieGatewayBaseURL(gateway string) string {
	address := strings.TrimRight(strings.TrimSpace(gateway), "/")
	if address == "" {
		return ""
	}
	if !strings.HasPrefix(address, "http://") && !strings.HasPrefix(address, "https://") {
		address = "http://" + address
	}
	if !strings.HasSuffix(address, "/v1") {
		address += "/v1"
	}
	return address
}

func fetchMagpieGatewayModels(gateway string) []magpieGatewayModel {
	base := magpieGatewayBaseURL(gateway)
	if base == "" {
		return nil
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(base + "/models")
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	var body struct {
		Data []magpieGatewayModel `json:"data"`
	}
	if json.NewDecoder(response.Body).Decode(&body) != nil {
		return nil
	}
	return body.Data
}

func magpieModelInputs(model magpieGatewayModel) []ModelInput {
	inputs := []ModelInput{}
	for _, input := range model.Modalities.Input {
		switch strings.ToLower(strings.TrimSpace(input)) {
		case "text":
			inputs = append(inputs, ModelInput("text"))
		case "image":
			inputs = append(inputs, ModelInput("image"))
		}
	}
	return inputs
}

func magpieTextLevel(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "none":
		return "off"
	case "off", "minimal", "low", "medium", "high", "xhigh", "max":
		return strings.ToLower(strings.TrimSpace(level))
	}
	return ""
}

func magpieDefaultThinkingLevel(model magpieGatewayModel) ModelThinkingLevel {
	if !model.Reasoning {
		return ModelThinkingLevel("off")
	}
	available := map[string]bool{}
	for _, level := range model.ReasoningLevels {
		if normalized := magpieTextLevel(level); normalized != "" {
			available[normalized] = true
		}
	}
	for _, preferred := range []string{"medium", "high", "low", "max", "minimal", "off"} {
		if available[preferred] {
			return ModelThinkingLevel(preferred)
		}
	}
	return ModelThinkingLevel("medium")
}

func magpieModelEntries(rows []magpieProviderRow, gateway string, models []magpieGatewayModel, existing map[string]bool) []ConfiguredModel {
	enabled := map[string]bool{}
	for _, row := range rows {
		enabled[row.ID] = row.Configured && !row.Off
	}
	baseURL := magpieGatewayBaseURL(gateway)
	entries := []ConfiguredModel{}
	seen := map[string]bool{}
	for _, model := range models {
		provider := strings.TrimSpace(model.OwnedBy)
		wireID := strings.TrimSpace(model.ID)
		if provider == "" || wireID == "" || !enabled[provider] {
			continue
		}
		id := provider + ":" + wireID
		if seen[id] || (existing != nil && existing[id]) {
			continue
		}
		seen[id] = true
		contextWindow := model.ContextWindow
		if contextWindow <= 0 {
			contextWindow = model.ContextLength
		}
		if contextWindow <= 0 {
			contextWindow = model.MaxInputTokens
		}
		maxTokens := model.MaxOutputTokens
		if maxTokens <= 0 {
			maxTokens = model.MaxTokens
		}
		reasoning := model.Reasoning
		entry := ModelEntry{
			Id:                   id,
			Provider:             provider,
			Api:                  ModelApiOpenAICompletions,
			BaseUrl:              baseURL,
			ContextWindow:        contextWindow,
			MaxTokens:            maxTokens,
			Input:                magpieModelInputs(model),
			Reasoning:            &reasoning,
			DefaultThinkingLevel: magpieDefaultThinkingLevel(model),
			CredentialId:         MAGPIE_CREDENTIAL_ID,
			ModelId:              wireID,
		}
		entries = append(entries, ConfiguredModel{
			ModelEntry: entry, ID: entry.Id, BaseURL: entry.BaseUrl,
			API: string(entry.Api), CredentialID: entry.CredentialId, ModelID: entry.ModelId,
		})
	}
	sort.SliceStable(entries, func(a, b int) bool { return entries[a].Id < entries[b].Id })
	return entries
}

func loadMagpieModelEntries(dir, gateway string) []ConfiguredModel {
	if strings.TrimSpace(gateway) == "" {
		return nil
	}
	view := loadMagpieProviders(dir, gateway)
	if !view.Available {
		return nil
	}
	return magpieModelEntries(view.Providers, gateway, view.ModelRows, nil)
}

func mergeMagpieConfiguredModels(base, extra []ConfiguredModel) []ConfiguredModel {
	merged := append([]ConfiguredModel{}, base...)
	seen := map[string]bool{}
	for _, entry := range merged {
		if entry.Id != "" {
			seen[entry.Id] = true
		}
	}
	for _, entry := range extra {
		if entry.Id == "" || seen[entry.Id] {
			continue
		}
		seen[entry.Id] = true
		merged = append(merged, entry)
	}
	return merged
}

type MagpieModels struct {
	mu      sync.Mutex
	dir     func() string
	gateway func() string
	entries []ConfiguredModel
	loaded  bool
}

func NewMagpieModels() *MagpieModels {
	return newMagpieModels(magpieConfigDir, func() string {
		return magpieGatewayAddress(magpieConfigDir())
	})
}

func newMagpieModels(dir, gateway func() string) *MagpieModels {
	return &MagpieModels{dir: dir, gateway: gateway}
}

func (models *MagpieModels) refresh() (magpieProvidersView, []ConfiguredModel) {
	dir := models.dir()
	gateway := models.gateway()
	view := loadMagpieProviders(dir, gateway)
	entries := []ConfiguredModel{}
	if view.Available {
		entries = magpieModelEntries(view.Providers, gateway, view.ModelRows, nil)
	}
	return view, entries
}

func (models *MagpieModels) Refresh() []ConfiguredModel {
	_, entries := models.refresh()
	models.mu.Lock()
	models.entries = entries
	models.loaded = true
	models.mu.Unlock()
	return append([]ConfiguredModel{}, entries...)
}

func (models *MagpieModels) Entries() []ConfiguredModel {
	models.mu.Lock()
	if models.loaded {
		entries := append([]ConfiguredModel{}, models.entries...)
		models.mu.Unlock()
		return entries
	}
	models.mu.Unlock()
	return models.Refresh()
}

func (models *MagpieModels) Merge(base []ConfiguredModel) []ConfiguredModel {
	return mergeMagpieConfiguredModels(base, models.Entries())
}

func (models *MagpieModels) CredentialFor(entry ConfiguredModel) *PiAdapterBinding {
	if entry.CredentialId != MAGPIE_CREDENTIAL_ID {
		return nil
	}
	return &PiAdapterBinding{ApiKey: magpieAPIKey(), CredentialId: MAGPIE_CREDENTIAL_ID}
}

func (models *MagpieModels) ProviderView() magpieProvidersView {
	view, entries := models.refresh()
	models.mu.Lock()
	models.entries = entries
	models.loaded = true
	models.mu.Unlock()
	return view
}
