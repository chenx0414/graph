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
