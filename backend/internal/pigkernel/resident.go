package pigkernel

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)


type resident struct {
	kernel   *Kernel
	models   *ai.Models
	registry harness.Registry
}

var residentKernels = struct {
	sync.Mutex
	values map[string]*resident
}{values: map[string]*resident{}}

func openResident(ctx context.Context, database string) (*resident, error) {
	residentKernels.Lock()
	defer residentKernels.Unlock()
	if found := residentKernels.values[database]; found != nil {
		return found, nil
	}
	registry := harness.CreateRegistry()
	models := ai.CreateModels()
	kernel, err := Open(ctx, Options{
		Database: database,
		Models:   models,
		Registry: registry,
		Settings: residentSettings,
	})
	if err != nil {
		return nil, err
	}
	found := &resident{kernel: kernel, models: models, registry: registry}
	residentKernels.values[database] = found
	return found, nil
}

func residentSettings() *harness.HarnessSettings {
	retry := harness.RetryPolicyPatch{Enabled: boolPointer(false)}
	compaction := harness.CompactionPolicyPatch{
		Enabled:          boolPointer(true),
		ReserveTokens:    intPointer(4096),
		KeepRecentTokens: intPointer(1024),
		BackgroundTokens: intPointer(0),
		ModelOverrides:   compactionPolicyOverrides(),
	}
	return &harness.HarnessSettings{Retry: &retry, Compaction: &compaction}
}

func CompactionPolicyFor(contextWindow int) (int, int) {
	if contextWindow < 1 {
		contextWindow = 1
	}
	reserve := contextWindow * 30 / 100
	if reserve < 1024 {
		reserve = 1024
	}
	half := contextWindow / 2
	if half < 1 {
		half = 1
	}
	if reserve > half {
		reserve = half
	}
	keep := contextWindow / 4
	if keep < 1024 {
		keep = 1024
	}
	if keep > 20000 {
		keep = 20000
	}
	return reserve, keep
}

var compactionPolicies = struct {
	sync.Mutex
	values map[string]durable.CompactionPolicyOverride
}{values: map[string]durable.CompactionPolicyOverride{}}

func RegisterCompactionPolicy(model string, reserve int, keep int) {
	if model == "" || (reserve <= 0 && keep <= 0) {
		return
	}
	override := durable.CompactionPolicyOverride{}
	if reserve > 0 {
		override.ReserveTokens = intPointer(reserve)
	}
	if keep > 0 {
		override.KeepRecentTokens = intPointer(keep)
	}
	compactionPolicies.Lock()
	compactionPolicies.values[model] = override
	compactionPolicies.Unlock()
}

func compactionPolicyOverrides() map[string]durable.CompactionPolicyOverride {
	compactionPolicies.Lock()
	defer compactionPolicies.Unlock()
	out := make(map[string]durable.CompactionPolicyOverride, len(compactionPolicies.values))
	for model, override := range compactionPolicies.values {
		out[model] = override
	}
	return out
}

func extensionName(identity string) string {
	return "graph-tools-" + digestOf(identity)
}

func ExtensionName(identity string) string {
	return extensionName(identity)
}

func providerName(identity string) string {
	return "graph-" + digestOf(identity)
}

func digestOf(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}

func buildModel(spec ModelSpec, providerID string) *ai.Model {
	return &ai.Model{
		ID:          spec.Id,
		DisplayName: spec.Name,
		Input:       []ai.ModelInputModality{"text"},
		Capabilities: ai.ModelCapabilities{
			ContextWindow:   spec.ContextWindow,
			MaxOutputTokens: spec.MaxTokens,
			SupportsToolUse: true,
		},
		ProviderMeta: ai.ProviderMetadata{ProviderID: providerID, API: apiOf(spec), BaseURL: spec.BaseURL},
	}
}

func apiOf(spec ModelSpec) ai.API {
	switch spec.API {
	case "anthropic-messages":
		return ai.APIAnthropicMessages
	case "openai-responses":
		return ai.APIOpenAIResponses
	}
	return ai.APIOpenAICompletions
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

func intPointer(value int) *int {
	return &value
}
