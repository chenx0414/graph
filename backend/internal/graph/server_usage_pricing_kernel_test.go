package graph

import (
	"os"
	"path/filepath"
	"testing"
)

// The kernel's catalog is the reference price.
//
// The console keeps a models.dev file for the same purpose, and the two
// disagree as soon as either side updates. The kernel is the one the runtime
// bills through, so its number wins; the file still prices the models the
// kernel has never heard of, which is what keeps a local model measurable.
func TestModelPricingTakesTheKernelAsTheReference(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".cc-switch", "model-pricing.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	file := `{"version":1,"models":[
	  {"modelId":"claude-haiku-5-5","displayName":"stale","inputCostPerMillion":"999","outputCostPerMillion":"999","cacheReadCostPerMillion":"999","cacheCreationCostPerMillion":"999"},
	  {"modelId":"local-only-model","displayName":"Local","inputCostPerMillion":"3","outputCostPerMillion":"4","cacheReadCostPerMillion":"0.3","cacheCreationCostPerMillion":"0.4"}
	]}`
	if err := os.WriteFile(path, []byte(file), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	service := &usageService{home: home, pricingPath: path, env: map[string]string{}}
	snapshot, err := service.Pricing()
	if err != nil {
		t.Fatalf("pricing: %v", err)
	}
	prices := map[string]ModelPrice{}
	for _, price := range snapshot.Models {
		prices[price.ModelID] = price
	}

	haiku, ok := prices["claude-haiku-5-5"]
	if !ok {
		t.Fatal("a kernel model has to be priced")
	}
	if haiku.InputCostPerMillion != 0.1 || haiku.OutputCostPerMillion != 0.5 {
		t.Fatalf("the kernel's price wins: got %v/%v, want 0.1/0.5", haiku.InputCostPerMillion, haiku.OutputCostPerMillion)
	}
	local, ok := prices["local-only-model"]
	if !ok || local.InputCostPerMillion != 3 {
		t.Fatalf("a model the kernel does not know keeps the file's price: %+v", local)
	}
	if _, ok := prices["grok-4.7"]; !ok {
		t.Fatal("the kernel's own models have to reach the table")
	}
}
