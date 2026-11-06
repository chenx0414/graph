package graph

import "github.com/MichaelKinsy/PiG/ai"

// usageKernelModels is the kernel's model catalog, seen as the usage page's own.
//
// The kernel generates the catalog from PiG's data, so the daemon reads it
// instead of keeping a second copy: a model upstream adds appears here without
// a second edit, and a field upstream corrects is corrected once.
//
// The base URL is deliberately left empty. The kernel's catalog names the
// public inference host; a subscription is configured against the endpoint
// that answers for it, and moving a request to a host the plan was not
// configured for would be a routing change disguised as a catalog read.
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

// kernelModelPrice is the kernel's price for one model: the four base rates and
// the volume tiers that go with them.
//
// The daemon keeps no price table of its own for a model the kernel catalogs.
// A price is the number a subscription is billed at, so a second copy is a
// second answer to the same question.
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

// kernelCostAmount is what one call costs at these rates.
//
// The arithmetic is the kernel's, not the daemon's: the kernel owns the tier
// rule (the highest threshold the whole prompt crossed replaces every base
// rate) and the per-million unit. A daemon that re-derived it would drift on
// the first price change upstream.
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
