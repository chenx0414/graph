package graph

// The host inventory the main Agent may read.
//
// The main Agent is the only Agent that is told what the host looks like:
// which models are configured, which recipes and definitions exist, which
// capabilities are installed, what the subscription plans report. The
// inventory never carries a secret value - a credential is reported as
// configured or not, never as its value.

// SystemDefinition is one published definition the inventory reports.
type SystemDefinition struct {
	ID      string
	Version int64
}

// SystemInventoryInput is everything the host inventory is built from.
type SystemInventoryInput struct {
	Models               []ConfiguredModel
	CredentialConfigured func(ConfiguredModel) bool
	Access               AccessPolicy
	Combinations         []AgentCombinationView
	Definitions          []SystemDefinition
	Architectures        []GraphArchitecture
	Plans                []UsagePlan
	Usage                UsageSummary
	Capabilities         []CapabilityRecord
	CapabilityRoot       string
	AgentContextRoot     string
	DocsRoot             string
	ApplicationRoot      string
	ApplicationMode      string
}

// systemInventoryKinds are the capability kinds the inventory counts.
var systemInventoryKinds = []string{"skill", "mcp", "extension", "pi-extension", "prompt"}

// SystemInventory is the host inventory the main Agent may read.
func SystemInventory(input SystemInventoryInput) map[string]any {
	models := []any{}
	for _, entry := range input.Models {
		model := map[string]any{
			"id":                   entry.Id,
			"provider":             entry.Provider,
			"modelId":              systemInventoryModelID(entry),
			"grade":                string(entry.Grade),
			"tier":                 string(ModelTierOf(entry.Grade)),
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
		"access":            input.Access,
		"agentCombinations": combinations,
		"agentDefinitions":  definitions,
		"architectures":     architectures,
		"subscriptionPlans": plans,
		"summary":           input.Usage,
		"capabilities": map[string]any{
			"root": input.CapabilityRoot, "entries": len(input.Capabilities), "byKind": byKind,
		},
		"agentContext": map[string]any{"root": input.AgentContextRoot, "docsRoot": input.DocsRoot},
		"application":  map[string]any{"root": input.ApplicationRoot, "mode": input.ApplicationMode},
	}
}

// systemInventoryModelID is the vendor-side model id of one configured model.
func systemInventoryModelID(entry ConfiguredModel) string {
	if entry.ModelId != "" {
		return entry.ModelId
	}
	return entry.Id
}

// systemInventoryPricingStatus says whether the price of one model is known.
func systemInventoryPricingStatus(entry ConfiguredModel) string {
	if entry.Pricing != nil && entry.Pricing.Status != "" {
		return entry.Pricing.Status
	}
	if entry.Cost != nil {
		return "known"
	}
	return "unknown"
}

// systemInventoryPlan is one subscription plan without its credential.
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
