package graph

import (
	"sort"
	"strings"
)

// usageParseModelPrices reads the local price table.
func usageParseModelPrices(raw any) []ModelPrice {
	prices := []ModelPrice{}
	for _, value := range usageArray(usageRecord(raw)["models"]) {
		item := usageRecord(value)
		if item == nil {
			continue
		}
		modelID := usageText(item["modelId"])
		if modelID == nil {
			continue
		}
		input := number(item["inputCostPerMillion"])
		output := number(item["outputCostPerMillion"])
		cacheRead := number(item["cacheReadCostPerMillion"])
		cacheCreation := number(item["cacheCreationCostPerMillion"])
		if input == nil || output == nil || cacheRead == nil || cacheCreation == nil {
			continue
		}
		displayName := *modelID
		if value := usageText(item["displayName"]); value != nil {
			displayName = *value
		}
		prices = append(prices, ModelPrice{
			ModelID: *modelID, DisplayName: displayName,
			InputCostPerMillion: *input, OutputCostPerMillion: *output,
			CacheReadCostPerMillion: *cacheRead, CacheCreationCostPerMillion: *cacheCreation,
		})
	}
	return prices
}

// usagePriceFor finds the archived price of a model.
func usagePriceFor(modelID string, prices []ModelPrice) *ModelPrice {
	normalized := strings.ToLower(modelID)
	for index := range prices {
		if strings.ToLower(prices[index].ModelID) == normalized {
			return &prices[index]
		}
	}
	for index := range prices {
		lowered := strings.ToLower(prices[index].ModelID)
		if strings.HasSuffix(normalized, lowered) || strings.HasSuffix(lowered, normalized) {
			return &prices[index]
		}
	}
	return nil
}

// usageSubscriptionModelValues are the optional overrides of a model entry.
type usageSubscriptionModelValues struct {
	ContextWindow *int
	MaxTokens     *int
	Reasoning     *bool
	Headers       map[string]string
}

// usageSubscriptionModel builds one subscription model entry.
func usageSubscriptionModel(id string, name string, provider UsageProviderId, api SubscriptionModelApi, baseURL string, prices []ModelPrice, values usageSubscriptionModelValues) SubscriptionModel {
	model := SubscriptionModel{
		ID: id, Name: name, API: api, BaseURL: baseURL,
		ContextWindow: 131_072, MaxTokens: 8_192,
		Reasoning: !usageNonReasoningPattern.MatchString(id),
		Supported: api != SubscriptionModelApiResponses,
	}
	if values.ContextWindow != nil {
		model.ContextWindow = *values.ContextWindow
	}
	if values.MaxTokens != nil {
		model.MaxTokens = *values.MaxTokens
	}
	if values.Reasoning != nil {
		model.Reasoning = *values.Reasoning
	}
	if price := usagePriceFor(id, prices); price != nil {
		input := price.InputCostPerMillion
		output := price.OutputCostPerMillion
		cacheRead := price.CacheReadCostPerMillion
		cacheCreation := price.CacheCreationCostPerMillion
		model.InputCostPerMillion = &input
		model.OutputCostPerMillion = &output
		model.CacheReadCostPerMillion = &cacheRead
		model.CacheCreationCostPerMillion = &cacheCreation
	}
	if values.Headers != nil {
		model.Headers = values.Headers
	}
	return model
}

// usageOpenAiModels reads the model list of an OpenAI-compatible endpoint.
func usageOpenAiModels(body map[string]any, provider UsageProviderId, baseURL string, api SubscriptionModelApi, prices []ModelPrice) []SubscriptionModel {
	rows := usageArray(body["data"])
	if len(rows) == 0 {
		rows = usageArray(body["models"])
	}
	if len(rows) == 0 {
		rows = usageArray(body)
	}
	models := []SubscriptionModel{}
	indexes := map[string]int{}
	for _, raw := range rows {
		if text, ok := raw.(string); ok {
			model := usageSubscriptionModel(text, text, provider, api, baseURL, prices, usageSubscriptionModelValues{})
			if existing, seen := indexes[model.ID]; seen {
				models[existing] = model
				continue
			}
			indexes[model.ID] = len(models)
			models = append(models, model)
			continue
		}
		item := usageRecord(raw)
		if item == nil {
			continue
		}
		id := usageText(item["id"])
		if id == nil {
			id = usageText(item["model"])
		}
		if id == nil {
			id = usageText(item["slug"])
		}
		if id == nil {
			continue
		}
		limit := usageRecord(item["limit"])
		contextWindow := 131_072
		if value := number(item["context_window"]); value != nil {
			contextWindow = int(*value)
		} else if value := number(item["contextWindow"]); value != nil {
			contextWindow = int(*value)
		} else if value := number(limit["context"]); value != nil {
			contextWindow = int(*value)
		}
		maxTokens := 8_192
		if value := number(item["max_output_tokens"]); value != nil {
			maxTokens = int(*value)
		} else if value := number(item["maxTokens"]); value != nil {
			maxTokens = int(*value)
		} else if value := number(limit["output"]); value != nil {
			maxTokens = int(*value)
		}
		reasoning := !usageNonReasoningPattern.MatchString(*id)
		if value := boolean(item["reasoning"]); value != nil {
			reasoning = *value
		}
		name := *id
		if value := usageText(item["name"]); value != nil {
			name = *value
		} else if value := usageText(item["display_name"]); value != nil {
			name = *value
		}
		model := usageSubscriptionModel(*id, name, provider, api, baseURL, prices, usageSubscriptionModelValues{
			ContextWindow: &contextWindow, MaxTokens: &maxTokens, Reasoning: &reasoning,
		})
		if existing, seen := indexes[model.ID]; seen {
			models[existing] = model
			continue
		}
		indexes[model.ID] = len(models)
		models = append(models, model)
	}
	return models
}

// usageFallbackModels builds the model list from known model ids.
func usageFallbackModels(keys []string, provider UsageProviderId, baseURL string, prices []ModelPrice) []SubscriptionModel {
	matches := keys
	if len(matches) == 0 {
		for _, price := range prices {
			matches = append(matches, price.ModelID)
		}
	}
	unique := []string{}
	seen := map[string]bool{}
	for _, id := range matches {
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	models := []SubscriptionModel{}
	for _, id := range unique {
		displayName := id
		if price := usagePriceFor(id, prices); price != nil {
			displayName = price.DisplayName
		}
		models = append(models, usageSubscriptionModel(id, displayName, provider, SubscriptionModelApiOpenAICompletions, baseURL, prices, usageSubscriptionModelValues{}))
	}
	return models
}

// usageOpenCodeConfiguredModelKeys reads the model ids the local OpenCode
// configuration names.
func usageOpenCodeConfiguredModelKeys(config any, ids []string) []string {
	providers := usageRecord(usageRecord(config)["provider"])
	if providers == nil {
		return []string{}
	}
	names := make([]string, 0, len(providers))
	for name := range providers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !usageContainsFold(ids, name) {
			continue
		}
		models := usageRecord(usageRecord(providers[name])["models"])
		keys := make([]string, 0, len(models))
		for key := range models {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return keys
	}
	return []string{}
}

// usageDiscoverOpenCodeModels reads the models an OpenCode Go subscription
// exposes.
func usageDiscoverOpenCodeModels(credential *usageCredential, prices []ModelPrice, openCodeConfig any) []SubscriptionModel {
	baseURL := credential.BaseURL
	if baseURL == "" {
		baseURL = usageDefaultBaseURLs[UsageProviderOpenCodeGo]
	}
	configuredKeys := usageOpenCodeConfiguredModelKeys(openCodeConfig, []string{"opencode-go"})
	status, _, raw, err := usageFetch("GET", usageModelsDevURL, map[string]string{"accept": "application/json"}, nil, usageRequestTimeoutMs)
	if err != nil {
		return usageOpenCodeFallbackModels(configuredKeys, baseURL, prices)
	}
	body, err := usageResponseJSON(status, raw, "models.dev")
	if err != nil {
		return usageOpenCodeFallbackModels(configuredKeys, baseURL, prices)
	}
	models := usageRecord(usageRecord(body["opencode-go"])["models"])
	if models == nil {
		return usageFallbackModels(configuredKeys, UsageProviderOpenCodeGo, baseURL, prices)
	}
	ids := map[string]bool{}
	for id := range models {
		ids[id] = true
	}
	for id := range usageOpenCodeModels {
		ids[id] = true
	}
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	result := []SubscriptionModel{}
	for _, id := range ordered {
		item := usageRecord(models[id])
		limit := usageRecord(item["limit"])
		pi, hasPi := usageOpenCodeModels[id]
		api := SubscriptionModelApiOpenAICompletions
		if hasPi {
			if pi.API == "anthropic-messages" {
				api = SubscriptionModelApiAnthropicMessages
			} else if pi.API == "openai-responses" {
				api = SubscriptionModelApiResponses
			}
		}
		name := id
		if value := usageText(item["name"]); value != nil {
			name = *value
		} else if hasPi {
			name = pi.Name
		}
		modelBaseURL := baseURL
		if hasPi {
			modelBaseURL = pi.BaseURL
		}
		contextWindow := 131_072
		if hasPi {
			contextWindow = pi.ContextWindow
		} else if value := number(limit["context"]); value != nil {
			contextWindow = int(*value)
		}
		maxTokens := 8_192
		if hasPi {
			maxTokens = pi.MaxTokens
		} else if value := number(limit["output"]); value != nil {
			maxTokens = int(*value)
		}
		reasoning := true
		if hasPi {
			reasoning = pi.Reasoning
		} else if value := boolean(item["reasoning"]); value != nil {
			reasoning = *value
		}
		result = append(result, usageSubscriptionModel(id, name, UsageProviderOpenCodeGo, api, modelBaseURL, prices, usageSubscriptionModelValues{
			ContextWindow: &contextWindow, MaxTokens: &maxTokens, Reasoning: &reasoning,
			Headers: map[string]string{"x-opencode-session": "graph-console"},
		}))
	}
	return result
}

// usageOpenCodeFallbackModels builds the OpenCode Go model list without the
// models.dev catalogue.
func usageOpenCodeFallbackModels(configuredKeys []string, baseURL string, prices []ModelPrice) []SubscriptionModel {
	models := usageFallbackModels(configuredKeys, UsageProviderOpenCodeGo, baseURL, prices)
	for index := range models {
		models[index].Headers = map[string]string{"x-opencode-session": "graph-console"}
	}
	return models
}

// usageDiscoverOpenAiCompatible reads the model list of an OpenAI-compatible
// subscription endpoint.
func usageDiscoverOpenAiCompatible(provider UsageProviderId, credential *usageCredential, prices []ModelPrice) []SubscriptionModel {
	baseURL := credential.BaseURL
	if baseURL == "" {
		baseURL = usageDefaultBaseURLs[provider]
	}
	status, _, raw, err := usageFetch("GET", strings.TrimRight(baseURL, "/")+"/models", map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
	}, nil, usageRequestTimeoutMs)
	if err != nil {
		return []SubscriptionModel{}
	}
	body, err := usageResponseJSON(status, raw, usagePlanBlueprints[provider].Name+" 模型")
	if err != nil {
		return []SubscriptionModel{}
	}
	return usageOpenAiModels(body, provider, baseURL, SubscriptionModelApiOpenAICompletions, prices)
}

// usageDiscoverChatGptModels reads the model list a ChatGPT subscription
// exposes.
func usageDiscoverChatGptModels(credential *usageCredential, prices []ModelPrice) []SubscriptionModel {
	headers := map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
		"user-agent": "codex-cli",
	}
	if credential.AccountID != nil {
		headers["chatgpt-account-id"] = *credential.AccountID
	}
	status, _, raw, err := usageFetch("GET", usageChatGPTModelsURL, headers, nil, usageRequestTimeoutMs)
	if err != nil {
		return usageChatGptFallbackModels(prices)
	}
	body, err := usageResponseJSON(status, raw, "ChatGPT 模型")
	if err != nil {
		return usageChatGptFallbackModels(prices)
	}
	return usageOpenAiModels(body, UsageProviderChatGPT, usageDefaultBaseURLs[UsageProviderChatGPT], SubscriptionModelApiResponses, prices)
}

// usageChatGptFallbackModels builds the ChatGPT model list from the archived
// prices.
func usageChatGptFallbackModels(prices []ModelPrice) []SubscriptionModel {
	keys := []string{}
	for _, price := range prices {
		lowered := strings.ToLower(price.ModelID)
		if strings.HasPrefix(lowered, "gpt-") || strings.HasPrefix(lowered, "codex") {
			keys = append(keys, price.ModelID)
		}
	}
	return usageFallbackModels(keys, UsageProviderChatGPT, usageDefaultBaseURLs[UsageProviderChatGPT], prices)
}
