package graph

import (
	"sort"

	"github.com/MichaelKinsy/PiG/ai"
)

func usageKernelModels(provider string) map[string]usagePiModel {
	catalog := map[string]usagePiModel{}
	for _, generated := range ai.ListModels(provider) {
		model := generated.ToModel()
		if model.ID == "" {
			continue
		}
		catalog[model.ID] = usagePiModel{
			ID:            model.ID,
			Name:          model.DisplayName,
			API:           string(model.ProviderMeta.API),
			Reasoning:     model.ProviderMeta.Reasoning,
			ContextWindow: model.Capabilities.ContextWindow,
			MaxTokens:     model.Capabilities.MaxOutputTokens,
		}
	}
	return catalog
}

func kernelModelPrice(provider, modelId string) *ModelCost {
	model := ai.GetBuiltinModel(provider, modelId)
	if model == nil {
		return nil
	}
	rates := model.CostRates()
	if rates.Input == 0 && rates.Output == 0 && rates.CacheRead == 0 && rates.CacheWrite == 0 && len(rates.Tiers) == 0 {
		return nil
	}
	cost := &ModelCost{Input: rates.Input, Output: rates.Output, CacheRead: rates.CacheRead, CacheWrite: rates.CacheWrite}
	for _, tier := range rates.Tiers {
		cost.Tiers = append(cost.Tiers, ModelCostTier{
			InputTokensAbove: tier.InputTokensAbove,
			Input:            tier.InputCostPer1M,
			Output:           tier.OutputCostPer1M,
			CacheRead:        tier.CacheReadCostPer1M,
			CacheWrite:       tier.CacheWriteCostPer1M,
		})
	}
	return cost
}

func kernelCostAmount(cost ModelCost, usage TokenUsage) float64 {
	capabilities := ai.ModelCapabilities{
		InputCostPer1M: cost.Input, OutputCostPer1M: cost.Output,
		CacheReadCostPer1M: cost.CacheRead, CacheWriteCostPer1M: cost.CacheWrite,
	}
	for _, tier := range cost.Tiers {
		capabilities.CostTiers = append(capabilities.CostTiers, ai.CostTier{
			InputTokensAbove:    tier.InputTokensAbove,
			InputCostPer1M:      tier.Input,
			OutputCostPer1M:     tier.Output,
			CacheReadCostPer1M:  tier.CacheRead,
			CacheWriteCostPer1M: tier.CacheWrite,
		})
	}
	model := &ai.Model{Capabilities: capabilities}
	charged := ai.Usage{
		Input: int(usage.Input), Output: int(usage.Output),
		CacheRead: int(usage.CacheRead), CacheWrite: int(usage.CacheWrite),
	}
	return ai.CalculateCost(model, &charged).Total
}

func kernelModelPrices() []ModelPrice {
	prices := []ModelPrice{}
	seen := map[string]bool{}
	for _, provider := range ai.ListProviders() {
		for _, generated := range ai.ListModels(provider) {
			model := generated.ToModel()
			if model.ID == "" || seen[model.ID] {
				continue
			}
			rates := model.CostRates()
			if rates.Input == 0 && rates.Output == 0 && rates.CacheRead == 0 && rates.CacheWrite == 0 && len(rates.Tiers) == 0 {
				continue
			}
			seen[model.ID] = true
			prices = append(prices, ModelPrice{
				ModelID: model.ID, DisplayName: model.DisplayName,
				InputCostPerMillion: rates.Input, OutputCostPerMillion: rates.Output,
				CacheReadCostPerMillion: rates.CacheRead, CacheCreationCostPerMillion: rates.CacheWrite,
			})
		}
	}
	sort.SliceStable(prices, func(left, right int) bool { return prices[left].ModelID < prices[right].ModelID })
	return prices
}
