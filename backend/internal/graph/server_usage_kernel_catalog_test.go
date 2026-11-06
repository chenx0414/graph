package graph

import (
	"testing"

	"github.com/MichaelKinsy/PiG/ai"
)

// The daemon's model catalog is the kernel's.
//
// Graph used to carry a hand-typed table of the OpenCode Go models because the
// catalog lived in a Node package. The kernel is Go now and generates the same
// catalog from PiG's own data, so the daemon reads it instead of maintaining a
// second copy that goes stale the first time upstream adds a model.
func TestUsageKernelCatalogIsTheKernelsOwn(t *testing.T) {
	catalog := usageKernelModels("opencode-go")
	if len(catalog) < 20 {
		t.Fatalf("the catalog has to be the kernel's full list, got %d models", len(catalog))
	}
	entry, ok := catalog["deepseek-v4.1-flash"]
	if !ok {
		t.Fatalf("the kernel's catalog lists deepseek-v4.1-flash; the daemon's copy does not: %d entries", len(catalog))
	}
	kernel := ai.GetBuiltinModel("opencode-go", "deepseek-v4.1-flash")
	if kernel == nil {
		t.Fatal("the kernel has no such model, so this test proves nothing")
	}
	if entry.Name != kernel.DisplayName {
		t.Fatalf("name %q, want the kernel's %q", entry.Name, kernel.DisplayName)
	}
	if entry.ContextWindow != kernel.Capabilities.ContextWindow || entry.MaxTokens != kernel.Capabilities.MaxOutputTokens {
		t.Fatalf("window %d/%d, want the kernel's %d/%d",
			entry.ContextWindow, entry.MaxTokens, kernel.Capabilities.ContextWindow, kernel.Capabilities.MaxOutputTokens)
	}
	if entry.API == "" {
		t.Fatal("every entry needs the api the kernel sends it with")
	}
}

// The catalog never moves a request: the plan's own endpoint wins, because the
// kernel's catalog names the public inference host while a subscription is
// configured against the endpoint that actually answers for it.
func TestUsageKernelCatalogLeavesTheEndpointToThePlan(t *testing.T) {
	for id, entry := range usageKernelModels("opencode-go") {
		if entry.BaseURL != "" {
			t.Fatalf("%s carries a base url from the kernel (%q); the plan's endpoint decides", id, entry.BaseURL)
		}
	}
}
