package graph

import (
	"regexp"
	"strings"

	"math"
)

type ModelTier string

type ModelGrade string

type ModelInput string

type ModelApi string

type ModelThinkingLevel string

var MODEL_TIERS = []ModelTier{"small", "medium", "frontier"}

// MODEL_GRADES keeps historical grades as explicit selectors.
var MODEL_GRADES = []ModelGrade{"small", "medium", "frontier", "low", "high", "highest"}

var gradeAliases = map[ModelGrade][]ModelGrade{
	"small":    {"small", "low"},
	"medium":   {"medium"},
	"frontier": {"frontier", "highest", "high"},
	"low":      {"low", "small"},
	"high":     {"high", "frontier"},
	"highest":  {"highest", "frontier"},
}

func ModelTierOf(grade ModelGrade) ModelTier {
	if grade == "low" || grade == "small" {
		return "small"
	}
	if grade == "medium" {
		return "medium"
	}
	return "frontier"
}

func ModelGradeMatches(requested, candidate ModelGrade) bool {
	for _, grade := range gradeAliases[requested] {
		if grade == candidate {
			return true
		}
	}
	return false
}

// MODEL_GRADE_ORDER is the cheap-first order used by auxiliary reviewers.
var MODEL_GRADE_ORDER = []ModelGrade{"low", "small", "medium", "high", "highest", "frontier"}

var MODEL_INPUTS = []ModelInput{"text", "image"}

var MODEL_THINKING_LEVELS = []ModelThinkingLevel{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

type ModelThinkingOption struct {
	Level ModelThinkingLevel `json:"level"`
	Label string             `json:"label"`
}

type ModelCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	// Tiers are the catalog's volume prices: the highest threshold the whole
	// prompt crossed replaces every base rate. They come from the kernel
	// catalog, which is where the numbers are maintained.
	Tiers []ModelCostTier `json:"tiers,omitempty"`
}

// ModelCostTier is one volume step of a model's price.
type ModelCostTier struct {
	InputTokensAbove float64 `json:"inputTokensAbove"`
	Input            float64 `json:"input"`
	Output           float64 `json:"output"`
	CacheRead        float64 `json:"cacheRead"`
	CacheWrite       float64 `json:"cacheWrite"`
}

type ModelPricing struct {
	Currency        string `json:"currency"`
	Unit            string `json:"unit"`
	SourceUrl       string `json:"sourceUrl,omitempty"`
	RetrievedAt     string `json:"retrievedAt,omitempty"`
	CatalogRevision string `json:"catalogRevision,omitempty"`
	Status          string `json:"status"`
}

type ModelEntry struct {
	Id                   string             `json:"id"`
	Provider             string             `json:"provider"`
	Grade                ModelGrade         `json:"grade"`
	Api                  ModelApi           `json:"api"`
	BaseUrl              string             `json:"baseUrl"`
	ContextWindow        int                `json:"contextWindow"`
	MaxTokens            int                `json:"maxTokens"`
	Input                []ModelInput       `json:"input,omitempty"`
	Reasoning            *bool              `json:"reasoning,omitempty"`
	DefaultThinkingLevel ModelThinkingLevel `json:"defaultThinkingLevel,omitempty"`
	Cost                 *ModelCost         `json:"cost,omitempty"`
	Pricing              *ModelPricing      `json:"pricing,omitempty"`
	Headers              map[string]string  `json:"headers,omitempty"`
	CredentialId         string             `json:"credentialId,omitempty"`
	ModelId              string             `json:"modelId,omitempty"`
	// FallbackModelId names the model this one falls back to when a send fails
	// at the provider boundary (connection error, timeout, non-2xx, a stream
	// that ended before its answer). It is one hop: a fallback names no fallback.
	FallbackModelId string `json:"fallbackModelId,omitempty"`
}

type ModelEntryView struct {
	ModelEntry
	Tier            ModelTier             `json:"tier"`
	ThinkingOptions []ModelThinkingOption `json:"thinkingOptions"`
}

func DefaultThinkingLevelFor(options []struct{ Level string }) string {
	if len(options) == 0 {
		return ""
	}
	if len(options) >= 2 {
		return options[len(options)-2].Level
	}
	return options[len(options)-1].Level
}

// ModelRequestHeaders are the provider headers that travel with every model request.
func ModelRequestHeaders(entry ModelEntry) map[string]string {
	openCodeGo := entry.Provider == "opencode-go" || strings.Contains(entry.BaseUrl, "opencode.ai/zen/go")
	if !openCodeGo {
		if len(entry.Headers) == 0 {
			return nil
		}
		return entry.Headers
	}
	headers := map[string]string{"x-opencode-session": "graph-console"}
	for key, value := range entry.Headers {
		headers[key] = value
	}
	return headers
}

type CostSummary struct {
	Unknown  bool               `json:"unknown"`
	Amounts  map[string]float64 `json:"amounts"`
	Amount   *float64           `json:"amount"`
	Currency *string            `json:"currency"`
}

func SumCosts(costs []any) CostSummary {
	amounts := map[string]float64{}
	var order []string
	unknown := false
	for _, cost := range costs {
		record, ok := cost.(map[string]any)
		if cost == nil || !ok {
			unknown = true
			continue
		}
		if record["unknown"] == true {
			unknown = true
			continue
		}
		amount, ok := record["amount"].(float64)
		if !ok || math.IsNaN(amount) || math.IsInf(amount, 0) {
			unknown = true
			continue
		}
		currency, _ := record["currency"].(string)
		if currency == "" {
			currency = "?"
		}
		if _, seen := amounts[currency]; !seen {
			order = append(order, currency)
		}
		amounts[currency] += amount
	}
	return costSummary(unknown, amounts, order)
}

func MergeCosts(summaries []CostSummary) CostSummary {
	amounts := map[string]float64{}
	var order []string
	unknown := false
	for _, summary := range summaries {
		unknown = unknown || summary.Unknown
		for currency, amount := range summary.Amounts {
			if _, seen := amounts[currency]; !seen {
				order = append(order, currency)
			}
			amounts[currency] += amount
		}
	}
	// TODO(port): merged currency key order follows each summary's map iteration, then first-seen.
	return costSummary(unknown, amounts, order)
}

func costSummary(unknown bool, amounts map[string]float64, order []string) CostSummary {
	if amounts == nil {
		amounts = map[string]float64{}
	}
	summary := CostSummary{Unknown: unknown, Amounts: amounts}
	if len(order) == 1 {
		amount := amounts[order[0]]
		currency := order[0]
		summary.Amount = &amount
		summary.Currency = &currency
	}
	return summary
}

func ParseDefinitionVersion(value string) (id string, version int) {
	trimmed := strings.TrimSpace(value)
	if match := definitionVersionPattern.FindStringSubmatch(trimmed); match != nil {
		number := 0
		for _, digit := range match[2] {
			number = number*10 + int(digit-'0')
		}
		return match[1], number
	}
	if trimmed == "" {
		Raise("invalid_input", "A definition version is required")
	}
	return trimmed, 1
}

var definitionVersionPattern = regexp.MustCompile(`^(.*)@(\d+)$`)

func EstimateCost(usage TokenUsage, cost *ModelCost, pricing *ModelPricing) any {
	if cost == nil {
		return map[string]any{"unknown": true}
	}
	values := []float64{cost.Input, cost.Output, cost.CacheRead, cost.CacheWrite}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return map[string]any{"unknown": true}
		}
	}
	amount := kernelCostAmount(*cost, usage)
	if math.IsNaN(amount) || math.IsInf(amount, 0) {
		return map[string]any{"unknown": true}
	}
	if pricing == nil {
		return struct {
			Amount float64 `json:"amount"`
		}{Amount: amount}
	}
	out := map[string]any{"amount": amount, "currency": pricing.Currency, "unit": pricing.Unit}
	if pricing.CatalogRevision != "" {
		out["priceRevision"] = pricing.CatalogRevision
	}
	return out
}

func ModelIdentity(entry ModelEntry) string {
	if entry.ModelId != "" {
		return entry.ModelId
	}
	return entry.Id
}

type SelectModelInput struct {
	Requested   string
	Grade       ModelGrade
	Directory   []ModelEntry
	Preferences map[ModelGrade][]string
	Exclude     []string
}

func SelectModel(input SelectModelInput) *ModelEntry {
	blocked := map[string]bool{}
	for _, id := range input.Exclude {
		blocked[id] = true
	}
	usable := []ModelEntry{}
	for _, model := range input.Directory {
		if blocked[ModelIdentity(model)] || blocked[model.Id] {
			continue
		}
		usable = append(usable, model)
	}
	if input.Requested != "" {
		for i := range usable {
			if usable[i].Id == input.Requested {
				return &usable[i]
			}
		}
	}
	preferenceGrades := []ModelGrade{input.Grade}
	if input.Grade == "small" || input.Grade == "frontier" {
		preferenceGrades = gradeAliases[input.Grade]
	}
	for _, grade := range preferenceGrades {
		for _, id := range input.Preferences[grade] {
			for i := range usable {
				if usable[i].Id == id {
					return &usable[i]
				}
			}
		}
	}
	for _, grade := range gradeAliases[input.Grade] {
		for i := range usable {
			if usable[i].Grade == grade {
				return &usable[i]
			}
		}
	}
	return nil
}
