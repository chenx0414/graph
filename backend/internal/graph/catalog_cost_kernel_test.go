package graph

import (
	"math"
	"testing"
)

// A tiered model bills the whole prompt at the tier it crossed, not at the base
// rate. The rule is the kernel's; the daemon asks it instead of re-deriving it,
// so a correction upstream reaches the recorded spend.
func TestEstimateCostAppliesTheKernelTierRule(t *testing.T) {
	cost := &ModelCost{
		Input: 1, Output: 2, CacheRead: 0.1, CacheWrite: 0.125,
		Tiers: []ModelCostTier{{InputTokensAbove: 100_000, Input: 0.5, Output: 2.5, CacheRead: 0.05, CacheWrite: 0.625}},
	}

	below := EstimateCost(TokenUsage{Input: 50_000, Output: 1_000}, cost, nil)
	if got := amountOf(below); !closeEnough(got, 0.052) {
		t.Fatalf("below the tier the base rate applies: got %v, want 0.052", got)
	}

	above := EstimateCost(TokenUsage{Input: 150_000, Output: 1_000}, cost, nil)
	if got := amountOf(above); !closeEnough(got, 0.0775) {
		t.Fatalf("above the tier the tier rate applies: got %v, want 0.0775", got)
	}
}

// A model the daemon configures without a cost takes the kernel's price and
// tiers, because that is where the catalog lives; an explicit cost still wins.
func TestModelWithoutConfiguredCostTakesTheKernelsPriceAndTiers(t *testing.T) {
	model := configParseModel(map[string]any{
		"id": "fast", "provider": "opencode-go", "modelId": "claude-haiku-5-5",
		"grade": "high", "api": "anthropic-messages",
		"baseUrl": "https://opencode.ai/zen/go/v1", "contextWindow": float64(1_000_000), "maxTokens": float64(128_000),
		"credentialId": "opencode-go",
	}, "models.entries[0]", map[string]CredentialConfig{"opencode-go": {}})
	if model.Cost == nil {
		t.Fatal("the kernel's price has to reach the entry")
	}
	if model.Cost.Input != 0.1 || model.Cost.Output != 0.5 || model.Cost.CacheRead != 0.01 || model.Cost.CacheWrite != 0.125 {
		t.Fatalf("rates %+v, want the kernel's 0.1/0.5/0.01/0.125", *model.Cost)
	}
	if len(model.Cost.Tiers) != 1 || model.Cost.Tiers[0].InputTokensAbove != 100_000 || model.Cost.Tiers[0].Output != 2.5 {
		t.Fatalf("tiers %+v, want the kernel's one tier above 100000 at 2.5", model.Cost.Tiers)
	}

	explicit := configParseModel(map[string]any{
		"id": "fast", "provider": "opencode-go", "modelId": "claude-haiku-5-5",
		"grade": "high", "api": "anthropic-messages",
		"baseUrl": "https://opencode.ai/zen/go/v1", "contextWindow": float64(1_000_000), "maxTokens": float64(128_000),
		"credentialId": "opencode-go",
		"cost":         map[string]any{"input": 7.0, "output": 8.0, "cacheRead": 0.5, "cacheWrite": 0.6},
	}, "models.entries[1]", map[string]CredentialConfig{"opencode-go": {}})
	if explicit.Cost == nil || explicit.Cost.Input != 7 {
		t.Fatalf("an explicit cost wins over the catalog: %+v", explicit.Cost)
	}
}

func amountOf(cost any) float64 {
	switch value := cost.(type) {
	case map[string]any:
		amount, _ := value["amount"].(float64)
		return amount
	case struct {
		Amount float64 `json:"amount"`
	}:
		return value.Amount
	}
	return math.NaN()
}

func closeEnough(got, want float64) bool { return math.Abs(got-want) < 1e-9 }
