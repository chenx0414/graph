package graph

import "encoding/json"

// PRICE_SNAPSHOT_BASE is the retrieval date frozen into archived prices.
const PRICE_SNAPSHOT_BASE = "2026-09-15"

// PriceSnapshot is one archived official price.
type PriceSnapshot struct {
	Provider        string
	ModelId         string
	Cost            ModelCost
	Currency        string
	Unit            string
	SourceUrl       string
	RetrievedAt     string
	CatalogRevision string
	Note            string
}

// PRICE_SNAPSHOT is the archived default price table. Unverified models are absent, never zero-filled.
var PRICE_SNAPSHOT = []PriceSnapshot{
	{Provider: "anthropic", ModelId: "claude-sonnet-4-5", Cost: ModelCost{Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 3.75}, Currency: "USD", Unit: "per_million_tokens", SourceUrl: "https://www.anthropic.com/pricing", RetrievedAt: PRICE_SNAPSHOT_BASE, CatalogRevision: PRICE_SNAPSHOT_BASE + ".anthropic"},
	{Provider: "anthropic", ModelId: "claude-haiku-4-5", Cost: ModelCost{Input: 1, Output: 5, CacheRead: 0.1, CacheWrite: 1.25}, Currency: "USD", Unit: "per_million_tokens", SourceUrl: "https://www.anthropic.com/pricing", RetrievedAt: PRICE_SNAPSHOT_BASE, CatalogRevision: PRICE_SNAPSHOT_BASE + ".anthropic"},
	{Provider: "deepseek", ModelId: "deepseek-flash", Cost: ModelCost{Input: 0.3, Output: 1.2, CacheRead: 0.006, CacheWrite: 0.3}, Currency: "USD", Unit: "per_million_tokens", SourceUrl: "https://api-docs.deepseek.com/quick_start/pricing", RetrievedAt: PRICE_SNAPSHOT_BASE, CatalogRevision: PRICE_SNAPSHOT_BASE + ".deepseek.peak", Note: "DeepSeek peak rate (off-peak is half); cache write conservatively priced at the miss rate."},
	{Provider: "deepseek", ModelId: "deepseek-v4-pro", Cost: ModelCost{Input: 1.32, Output: 3.96, CacheRead: 0.044, CacheWrite: 1.32}, Currency: "USD", Unit: "per_million_tokens", SourceUrl: "https://api-docs.deepseek.com/quick_start/pricing", RetrievedAt: PRICE_SNAPSHOT_BASE, CatalogRevision: PRICE_SNAPSHOT_BASE + ".deepseek.peak", Note: "DeepSeek peak rate (off-peak is half); cache write conservatively priced at the miss rate."},
}

// SnapshotFor looks up one archived entry by provider and upstream model id.
func SnapshotFor(provider, modelId string) *PriceSnapshot {
	for i := range PRICE_SNAPSHOT {
		if PRICE_SNAPSHOT[i].Provider == provider && PRICE_SNAPSHOT[i].ModelId == modelId {
			return &PRICE_SNAPSHOT[i]
		}
	}
	return nil
}

// SnapshotPricing copies provenance without copying the frozen cost.
func SnapshotPricing(snapshot PriceSnapshot, options ...string) ModelPricing {
	revision := ""
	retrievedAt := ""
	if len(options) > 0 {
		revision = options[0]
	}
	if len(options) > 1 {
		retrievedAt = options[1]
	}
	if revision == "" {
		revision = snapshot.CatalogRevision
	}
	if retrievedAt == "" {
		retrievedAt = snapshot.RetrievedAt
	}
	return ModelPricing{Currency: snapshot.Currency, Unit: snapshot.Unit, SourceUrl: snapshot.SourceUrl, RetrievedAt: retrievedAt, CatalogRevision: revision, Status: "known"}
}

// PriceRefreshResult is one model's refresh outcome.
type PriceRefreshResult struct {
	ModelId   string  `json:"modelId"`
	Provider  string  `json:"provider"`
	Status    string  `json:"status"`
	SourceUrl *string `json:"sourceUrl,omitempty"`
	Reason    *string `json:"reason,omitempty"`
}

// ApplyPriceSnapshot re-stamps archived entries. It never zero-fills and never rewrites historical invocation cost.
func ApplyPriceSnapshot(document any, verify func(PriceSnapshot) bool, revision, retrievedAt string) (any, []PriceRefreshResult) {
	results := []PriceRefreshResult{}
	if document == nil {
		return document, results
	}
	if _, ok := document.(map[string]any); !ok {
		if _, ok := document.([]any); !ok {
			switch document.(type) {
			case string, float64, bool, json.Number:
				return document, results
			}
		}
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		panic(err)
	}
	var copy any
	if err := json.Unmarshal(encoded, &copy); err != nil {
		panic(err)
	}
	root, ok := copy.(map[string]any)
	if !ok {
		return copy, results
	}
	models, _ := root["models"].(map[string]any)
	entries, _ := models["entries"].([]any)
	if entries == nil {
		return copy, results
	}
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		provider, _ := entry["provider"].(string)
		upstream, _ := entry["modelId"].(string)
		if upstream == "" {
			upstream, _ = entry["id"].(string)
		}
		previous, _ := entry["pricing"].(map[string]any)
		snapshot := SnapshotFor(provider, upstream)
		if snapshot == nil {
			if previous != nil && previous["status"] == "known" && previous["sourceUrl"] == "manual" {
				reason := "manual override kept"
				results = append(results, PriceRefreshResult{ModelId: upstream, Provider: provider, Status: "manual", Reason: &reason})
			} else {
				reason := "no archived price for this model"
				results = append(results, PriceRefreshResult{ModelId: upstream, Provider: provider, Status: "unknown", Reason: &reason})
			}
			continue
		}
		verified := false
		func() {
			defer func() { _ = recover() }()
			verified = verify(*snapshot)
		}()
		source := snapshot.SourceUrl
		if verified {
			entry["cost"] = map[string]any{"input": snapshot.Cost.Input, "output": snapshot.Cost.Output, "cacheRead": snapshot.Cost.CacheRead, "cacheWrite": snapshot.Cost.CacheWrite}
			entry["pricing"] = map[string]any{"currency": snapshot.Currency, "unit": snapshot.Unit, "sourceUrl": snapshot.SourceUrl, "retrievedAt": retrievedAt, "catalogRevision": revision, "status": "known"}
			results = append(results, PriceRefreshResult{ModelId: upstream, Provider: provider, Status: "known", SourceUrl: &source})
			continue
		}
		if entry["cost"] != nil {
			pricing := map[string]any{}
			for key, value := range previous {
				pricing[key] = value
			}
			currency := snapshot.Currency
			if previous != nil {
				if value, exists := previous["currency"]; exists && value != nil {
					if text, ok := value.(string); ok {
						currency = text
					}
				}
			}
			pricing["currency"] = currency
			pricing["unit"] = "per_million_tokens"
			pricing["status"] = "stale"
			entry["pricing"] = pricing
			reason := "official page could not be re-verified; previous amount kept"
			results = append(results, PriceRefreshResult{ModelId: upstream, Provider: provider, Status: "stale", SourceUrl: &source, Reason: &reason})
		} else {
			reason := "no verified price; refresh failed"
			results = append(results, PriceRefreshResult{ModelId: upstream, Provider: provider, Status: "unknown", SourceUrl: &source, Reason: &reason})
		}
	}
	return copy, results
}
