package graph

import (
	"math"
	"sort"
	"strings"
)

func configPositiveInt(value any, path string) int {
	n, ok := configFiniteInt(value)
	if !ok || n <= 0 {
		configInvalid(path + " must be a positive integer")
	}
	return n
}

func configAsCost(value any, path string) ModelCost {
	raw := asObject(value, path)
	field := func(name string) float64 {
		current, ok := raw[name]
		if !ok {
			configInvalid(path + "." + name + " must be a nonnegative number")
		}
		number, isFloat := current.(float64)
		if !isFloat {
			if parsed, ok := configFiniteInt(current); ok {
				number = float64(parsed)
				isFloat = true
			}
		}
		if !isFloat || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
			configInvalid(path + "." + name + " must be a nonnegative number")
		}
		return number
	}
	return ModelCost{Input: field("input"), Output: field("output"), CacheRead: field("cacheRead"), CacheWrite: field("cacheWrite")}
}

func configAsPricing(value any, path string) ModelPricing {
	raw := asObject(value, path)
	status := "known"
	if _, ok := raw["status"]; ok {
		status = configAsString(raw["status"], path+".status")
	}
	if status != "known" && status != "stale" && status != "unknown" {
		configInvalid(path + ".status must be known, stale or unknown")
	}
	if raw["unit"] != "per_million_tokens" {
		configInvalid(path + ".unit must be \"per_million_tokens\"")
	}
	pricing := ModelPricing{
		Currency: configAsString(raw["currency"], path+".currency"),
		Unit:     "per_million_tokens",
		Status:   status,
	}
	if text := configOptionalPresent(raw, "sourceUrl", path+".sourceUrl"); text != "" {
		pricing.SourceUrl = text
	}
	if text := configOptionalPresent(raw, "retrievedAt", path+".retrievedAt"); text != "" {
		pricing.RetrievedAt = text
	}
	if text := configOptionalPresent(raw, "catalogRevision", path+".catalogRevision"); text != "" {
		pricing.CatalogRevision = text
	}
	return pricing
}

func configOptionalPresent(raw map[string]any, name, path string) string {
	value, ok := raw[name]
	if !ok || value == nil {
		return ""
	}
	return configAsString(value, path)
}

func configAsHeaders(value any, path string) map[string]string {
	entries := asObject(value, path)
	if len(entries) > 20 {
		configInvalid(path + " must declare at most 20 headers")
	}
	headers := map[string]string{}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !configHeader.MatchString(name) {
			configInvalid(path + "." + name + " is not a valid header name")
		}
		header, ok := entries[name].(string)
		if !ok || header == "" || len(header) > 512 {
			configInvalid(path + "." + name + " must be a non-empty string of at most 512 characters")
		}
		headers[name] = header
	}
	return headers
}

func configThinkingLevel(value any, path string) ModelThinkingLevel {
	level := configAsString(value, path)
	for _, item := range MODEL_THINKING_LEVELS {
		if string(item) == level {
			return item
		}
	}
	configInvalid(path + " must be one of " + configJoinLevels(MODEL_THINKING_LEVELS))
	return ""
}

func configJoinLevels[T ~string](items []T) string {
	parts := make([]string, len(items))
	for i, item := range items {
		parts[i] = string(item)
	}
	return strings.Join(parts, ", ")
}

func configModelInputs(value any, path string) []ModelInput {
	items := configAsArray(value, path)
	if len(items) == 0 {
		configInvalid(path + " must contain at least one input modality")
	}
	values := make([]ModelInput, len(items))
	seen := map[string]bool{}
	hasText := false
	for index, item := range items {
		text := configAsString(item, path+"["+itoa(index)+"]")
		allowed := false
		for _, input := range MODEL_INPUTS {
			if string(input) == text {
				allowed = true
				values[index] = input
				break
			}
		}
		if !allowed {
			configInvalid(path + " contains unsupported input modality \"" + text + "\"")
		}
		if text == "text" {
			hasText = true
		}
		if seen[text] {
			configInvalid(path + " must not contain duplicate input modalities")
		}
		seen[text] = true
	}
	if !hasText {
		configInvalid(path + " must include \"text\"")
	}
	return values
}
