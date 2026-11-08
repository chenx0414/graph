package graph

type SystemDefinition struct {
	ID      string
	Version int64
}

type SystemInventoryInput struct {
	Models               []ConfiguredModel
	CredentialConfigured func(ConfiguredModel) bool
	Combinations         []AgentCombinationView
	Definitions          []SystemDefinition
	Architectures        []GraphArchitecture
	Plans                []UsagePlan
	Usage                UsageSummary
	Capabilities         []CapabilityRecord
	CapabilityRoot       string
	AgentContextRoot     string
	ApplicationRoot      string
	ApplicationMode      string
}

var systemInventoryKinds = []string{"skill", "mcp", "extension", "pi-extension", "prompt"}

func SystemInventory(input SystemInventoryInput) map[string]any {
	models := []any{}
	for _, entry := range input.Models {
		model := map[string]any{
			"id":                   entry.Id,
			"provider":             entry.Provider,
			"modelId":              systemInventoryModelID(entry),
			"reasoning":            entry.Reasoning == nil || *entry.Reasoning,
			"contextWindow":        entry.ContextWindow,
			"maxTokens":            entry.MaxTokens,
			"credentialConfigured": input.CredentialConfigured != nil && input.CredentialConfigured(entry),
			"pricingStatus":        systemInventoryPricingStatus(entry),
		}
		if entry.DefaultThinkingLevel != "" {
			model["defaultThinkingLevel"] = string(entry.DefaultThinkingLevel)
		}
		models = append(models, model)
	}
	definitions := []any{}
	for _, item := range input.Definitions {
		definitions = append(definitions, map[string]any{"id": item.ID, "version": item.Version})
	}
	combinations := []any{}
	for _, item := range input.Combinations {
		combinations = append(combinations, item)
	}
	architectures := []any{}
	for _, item := range input.Architectures {
		architectures = append(architectures, item)
	}
	plans := []any{}
	for _, plan := range input.Plans {
		plans = append(plans, systemInventoryPlan(plan))
	}
	byKind := map[string]any{}
	for _, kind := range systemInventoryKinds {
		count := 0
		for _, entry := range input.Capabilities {
			if entry.Kind == kind {
				count++
			}
		}
		byKind[kind] = count
	}
	return map[string]any{
		"configuredModels":  models,
		"agentCombinations": combinations,
		"agentDefinitions":  definitions,
		"architectures":     architectures,
		"subscriptionPlans": plans,
		"summary":           input.Usage,
		"capabilities": map[string]any{
			"root": input.CapabilityRoot, "entries": len(input.Capabilities), "byKind": byKind,
		},
		"agentContext": map[string]any{"root": input.AgentContextRoot},
		"application":  map[string]any{"root": input.ApplicationRoot, "mode": input.ApplicationMode},
	}
}

func systemInventoryModelID(entry ConfiguredModel) string {
	if entry.ModelId != "" {
		return entry.ModelId
	}
	return entry.Id
}

func systemInventoryPricingStatus(entry ConfiguredModel) string {
	if entry.Pricing != nil && entry.Pricing.Status != "" {
		return entry.Pricing.Status
	}
	if entry.Cost != nil {
		return "known"
	}
	return "unknown"
}

func systemInventoryPlan(plan UsagePlan) map[string]any {
	models := []any{}
	for _, model := range plan.Models {
		entry := map[string]any{
			"id": model.ID, "name": model.Name, "reasoning": model.Reasoning, "supported": model.Supported,
			"contextWindow": model.ContextWindow, "maxTokens": model.MaxTokens,
		}
		if model.InputCostPerMillion != nil {
			entry["inputCostPerMillion"] = *model.InputCostPerMillion
		}
		if model.OutputCostPerMillion != nil {
			entry["outputCostPerMillion"] = *model.OutputCostPerMillion
		}
		models = append(models, entry)
	}
	return map[string]any{
		"id": plan.ID, "name": plan.Name, "configured": plan.Configured, "status": plan.Status,
		"plan": plan.Plan, "models": models, "windows": plan.Windows, "balance": plan.Balance,
		"error": plan.Error, "updatedAt": plan.UpdatedAt,
	}
}
