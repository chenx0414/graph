package graph

import (
	"math"
	"os"
	"regexp"
	"strings"

	"encoding/json"
)

const MODELS_DEV_SOURCE_URL = "https://models.dev/api.json"

const MODELS_DEV_ATTRIBUTION = "models.dev community catalog (MIT). Attribution: https://models.dev"

// MODELS_DEV_LICENSE is kept for older callers.
const MODELS_DEV_LICENSE = MODELS_DEV_ATTRIBUTION

// ModelMetadata is what the snapshot says about one model. An absent field means
// the snapshot does not say, never zero.
type ModelMetadata struct {
	ContextWindow        *int                  `json:"contextWindow,omitempty"`
	MaxTokens            *int                  `json:"maxTokens,omitempty"`
	Input                []ModelInput          `json:"input,omitempty"`
	Reasoning            *bool                 `json:"reasoning,omitempty"`
	ThinkingLevels       []ModelThinkingLevel  `json:"thinkingLevels,omitempty"`
	ThinkingOptions      []ModelThinkingOption `json:"thinkingOptions,omitempty"`
	DefaultThinkingLevel ModelThinkingLevel    `json:"defaultThinkingLevel,omitempty"`
	Cost                 *ModelCost            `json:"cost,omitempty"`
	Currency             string                `json:"currency,omitempty"`
	SourceUrl            string                `json:"sourceUrl,omitempty"`
	CatalogRevision      string                `json:"catalogRevision,omitempty"`
}

type ModelsDevReasoningOption struct {
	Type   string `json:"type,omitempty"`
	Values []any  `json:"values,omitempty"`
}

type ModelsDevModel struct {
	Id               string                     `json:"id,omitempty"`
	Name             string                     `json:"name,omitempty"`
	Reasoning        *bool                      `json:"reasoning,omitempty"`
	ReasoningOptions []ModelsDevReasoningOption `json:"reasoning_options,omitempty"`
	Modalities       *struct {
		Input  []any `json:"input,omitempty"`
		Output []any `json:"output,omitempty"`
	} `json:"modalities,omitempty"`
	Limit *struct {
		Context any `json:"context,omitempty"`
		Output  any `json:"output,omitempty"`
	} `json:"limit,omitempty"`
	Cost *struct {
		Input      any `json:"input,omitempty"`
		Output     any `json:"output,omitempty"`
		CacheRead  any `json:"cache_read,omitempty"`
		CacheWrite any `json:"cache_write,omitempty"`
		Currency   any `json:"currency,omitempty"`
	} `json:"cost,omitempty"`
}

type ModelsDevProvider struct {
	Id     string                    `json:"id,omitempty"`
	Name   string                    `json:"name,omitempty"`
	Models map[string]ModelsDevModel `json:"models,omitempty"`
}

type ModelsDevSnapshot struct {
	SourceUrl   string                       `json:"sourceUrl,omitempty"`
	FetchedAt   string                       `json:"fetchedAt,omitempty"`
	Attribution string                       `json:"attribution,omitempty"`
	Providers   map[string]ModelsDevProvider `json:"providers"`
}

type CatalogProvenanceRecord struct {
	SourceUrl       string
	RetrievedAt     string
	CatalogRevision string
	Attribution     string
	HasRetrievedAt  bool
	HasRevision     bool
}

var modelsDevProviderAliases = map[string][]string{
	"opencode-go":  {"opencode-go", "opencode"},
	"command-goat": {"command-goat", "commandcode"},
	"grok":         {"xai", "grok"},
	"chatgpt":      {"openai", "chatgpt"},
	"deepseek":     {"deepseek"},
	"openai":       {"openai"},
	"anthropic":    {"anthropic"},
	"gemini":       {"google", "gemini"},
	"google":       {"google"},
	"openrouter":   {"openrouter"},
}

var modelsDevThinkingAliases = map[string]ModelThinkingLevel{
	"none": "off", "off": "off", "minimal": "minimal", "low": "low",
	"medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max",
}

var modelsDevAccountSuffix = regexp.MustCompile(`-\d+$`)

var modelsDevCached *ModelsDevSnapshot

func modelsDevRecord(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok
}

func modelsDevPositive(value any) *int {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return nil
	}
	n := int(number)
	return &n
}

func modelsDevFiniteAmount(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return 0, false
	}
	return number, true
}

func modelsDevOptionalCost(cost map[string]any) *ModelCost {
	if cost == nil {
		return nil
	}
	input, okIn := modelsDevFiniteAmount(cost["input"])
	output, okOut := modelsDevFiniteAmount(cost["output"])
	cacheRead, okRead := modelsDevFiniteAmount(cost["cache_read"])
	cacheWrite, okWrite := modelsDevFiniteAmount(cost["cache_write"])
	if !okIn || !okOut || !okRead || !okWrite {
		return nil
	}
	return &ModelCost{Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite}
}

func modelsDevThinkingOptions(model map[string]any) []ModelThinkingOption {
	found := map[ModelThinkingLevel]string{}
	options, _ := model["reasoning_options"].([]any)
	for _, item := range options {
		option, ok := item.(map[string]any)
		if !ok || option["type"] != "effort" {
			continue
		}
		values, _ := option["values"].([]any)
		for _, value := range values {
			label := strings.TrimSpace(modelsDevAnyString(value))
			level, known := modelsDevThinkingAliases[strings.ToLower(label)]
			if !known {
				continue
			}
			if _, seen := found[level]; seen {
				continue
			}
			found[level] = label
		}
	}
	out := []ModelThinkingOption{}
	for _, level := range MODEL_THINKING_LEVELS {
		if label, ok := found[level]; ok {
			out = append(out, ModelThinkingOption{Level: level, Label: label})
		}
	}
	return out
}

func modelsDevAnyString(value any) string {
	text, _ := value.(string)
	if text == "" {
		if number, ok := value.(float64); ok {
			return jsonNumberText(number)
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		return strings.Trim(string(raw), `"`)
	}
	return text
}

func jsonNumberText(number float64) string {
	raw, err := json.Marshal(number)
	if err != nil {
		return ""
	}
	return string(raw)
}

func modelsDevInputModalities(model map[string]any) []ModelInput {
	modalities, _ := model["modalities"].(map[string]any)
	inputs, _ := modalities["input"].([]any)
	if len(inputs) == 0 {
		return nil
	}
	for _, value := range inputs {
		if modelsDevAnyString(value) == "image" {
			return []ModelInput{"text", "image"}
		}
	}
	return []ModelInput{"text"}
}

// NormalizeModelsDevSnapshot accepts the refresh wrapper, the earlier envelope, and a bare provider map.
func NormalizeModelsDevSnapshot(raw any) ModelsDevSnapshot {
	root, ok := modelsDevRecord(raw)
	if !ok {
		return ModelsDevSnapshot{Providers: map[string]ModelsDevProvider{}}
	}
	meta, _ := modelsDevRecord(root["_meta"])
	if _, hasProviders := root["providers"]; hasProviders {
		mapped, _ := modelsDevRecord(root["providers"])
		snapshot := ModelsDevSnapshot{Providers: modelsDevProviders(mapped)}
		sourceUrl := modelsDevFirstString(meta["sourceUrl"], root["sourceUrl"], root["license"])
		fetchedAt := modelsDevFirstString(meta["fetchedAt"], root["fetchedAt"])
		attribution := modelsDevFirstString(meta["attribution"], meta["license"], root["attribution"], root["license"])
		if sourceUrl != "" {
			snapshot.SourceUrl = sourceUrl
		}
		if fetchedAt != "" {
			snapshot.FetchedAt = fetchedAt
		}
		if attribution != "" {
			snapshot.Attribution = attribution
		}
		return snapshot
	}
	return ModelsDevSnapshot{Providers: modelsDevProviders(root)}
}

func modelsDevFirstString(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok && text != "" {
			return text
		}
	}
	return ""
}

func modelsDevProviders(raw map[string]any) map[string]ModelsDevProvider {
	out := map[string]ModelsDevProvider{}
	if raw == nil {
		return out
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(encoded, &out); err != nil {
		panic(err)
	}
	return out
}

func BuiltinModelsDevSnapshot() ModelsDevSnapshot {
	if modelsDevCached == nil {
		body, err := os.ReadFile(ApplicationRoot + "/src/catalog/models-dev.snapshot.json")
		if err != nil {
			panic(err)
		}
		var raw any
		if err := json.Unmarshal(body, &raw); err != nil {
			panic(err)
		}
		snapshot := NormalizeModelsDevSnapshot(raw)
		modelsDevCached = &snapshot
	}
	return *modelsDevCached
}

func CatalogProvenance(snapshot any) CatalogProvenanceRecord {
	if snapshot == nil {
		return catalogProvenanceFromSnapshot(BuiltinModelsDevSnapshot())
	}
	if typed, ok := snapshot.(ModelsDevSnapshot); ok {
		return catalogProvenanceFromSnapshot(typed)
	}
	return catalogProvenanceFromSnapshot(NormalizeModelsDevSnapshot(snapshot))
}

func catalogProvenanceFromSnapshot(source ModelsDevSnapshot) CatalogProvenanceRecord {
	provenance := CatalogProvenanceRecord{
		SourceUrl:   source.SourceUrl,
		Attribution: source.Attribution,
	}
	if provenance.SourceUrl == "" {
		provenance.SourceUrl = MODELS_DEV_SOURCE_URL
	}
	if source.FetchedAt != "" {
		provenance.RetrievedAt = source.FetchedAt
		provenance.HasRetrievedAt = true
		provenance.CatalogRevision = "models-dev." + source.FetchedAt
		provenance.HasRevision = true
	}
	if provenance.Attribution == "" {
		provenance.Attribution = MODELS_DEV_ATTRIBUTION
	}
	return provenance
}

func modelsDevResolveProvider(snapshot ModelsDevSnapshot, providerHint string) (ModelsDevProvider, bool) {
	hint := strings.ToLower(strings.TrimSpace(providerHint))
	if hint == "" {
		return ModelsDevProvider{}, false
	}
	accountBase := modelsDevAccountSuffix.ReplaceAllString(hint, "")
	platform := hint
	if accountBase != hint {
		if _, known := modelsDevProviderAliases[accountBase]; known {
			platform = accountBase
		}
	}
	candidates := append([]string{}, modelsDevProviderAliases[platform]...)
	candidates = append(candidates, platform)
	for _, candidate := range candidates {
		if provider, ok := snapshot.Providers[candidate]; ok {
			return provider, true
		}
	}
	return ModelsDevProvider{}, false
}

func modelsDevResolveModel(provider ModelsDevProvider, modelId string) (map[string]any, bool) {
	id := strings.TrimSpace(modelId)
	if id == "" || provider.Models == nil {
		return nil, false
	}
	segment := id
	if slash := strings.LastIndex(id, "/"); slash >= 0 {
		segment = id[slash+1:]
	}
	raw, err := json.Marshal(provider.Models)
	if err != nil {
		panic(err)
	}
	var models map[string]any
	if err := json.Unmarshal(raw, &models); err != nil {
		panic(err)
	}
	if direct, ok := models[id].(map[string]any); ok {
		return direct, true
	}
	if direct, ok := models[segment].(map[string]any); ok {
		return direct, true
	}
	for key, value := range models {
		model, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if key == id || key == segment || strings.HasSuffix(key, "/"+segment) || key[strings.LastIndex(key, "/")+1:] == segment {
			return model, true
		}
		if modelIdText, _ := model["id"].(string); modelIdText == id || modelIdText == segment {
			return model, true
		}
	}
	return nil, false
}

// LookupModelMetadata maps one provider/model pair. Null means the snapshot has no such model.
func LookupModelMetadata(providerHint, modelId string, snapshot ...any) *ModelMetadata {
	var source ModelsDevSnapshot
	if len(snapshot) == 0 || snapshot[0] == nil {
		source = BuiltinModelsDevSnapshot()
	} else {
		source = NormalizeModelsDevSnapshot(snapshot[0])
	}
	if source.Providers == nil {
		return nil
	}
	provider, ok := modelsDevResolveProvider(source, providerHint)
	if !ok {
		return nil
	}
	model, ok := modelsDevResolveModel(provider, modelId)
	if !ok {
		return nil
	}
	limit, _ := model["limit"].(map[string]any)
	meta := &ModelMetadata{}
	if window := modelsDevPositive(limit["context"]); window != nil {
		meta.ContextWindow = window
	}
	if tokens := modelsDevPositive(limit["output"]); tokens != nil {
		meta.MaxTokens = tokens
	}
	if input := modelsDevInputModalities(model); input != nil {
		meta.Input = input
	}
	if reasoning, ok := model["reasoning"].(bool); ok {
		meta.Reasoning = &reasoning
	}
	options := modelsDevThinkingOptions(model)
	if len(options) > 0 {
		levels := make([]ModelThinkingLevel, len(options))
		for i, option := range options {
			levels[i] = option.Level
		}
		meta.ThinkingLevels = levels
		meta.ThinkingOptions = options
	}
	costRecord, _ := model["cost"].(map[string]any)
	if cost := modelsDevOptionalCost(costRecord); cost != nil {
		meta.Cost = cost
		currency, _ := costRecord["currency"].(string)
		if currency == "" {
			currency = "USD"
		}
		meta.Currency = currency
	}
	provenance := catalogProvenanceFromSnapshot(source)
	meta.SourceUrl = provenance.SourceUrl
	if provenance.HasRevision {
		meta.CatalogRevision = provenance.CatalogRevision
	}
	return meta
}
