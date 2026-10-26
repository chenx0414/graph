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

// The resident kernel.
//
// One kernel serves every session of one database. It stays open for the life
// of the daemon: the durable conversations it holds are the sessions'
// transcripts, and a kernel that closed would take the shared storage with it.
//
// The registry and the model runtime are shared as well. Every session
// installs its own extension under its own name and registers its own
// provider, and the kernel resolves the extension a conversation selected, so
// two sessions never see each other's tools.

// resident is one kernel the process keeps open.
type resident struct {
	kernel   *Kernel
	models   *ai.Models
	registry harness.Registry
}

// residentKernels are the kernels the process keeps open.
var residentKernels = struct {
	sync.Mutex
	values map[string]*resident
}{values: map[string]*resident{}}

// openResident opens the kernel of one database, or returns the one that is
// already open.
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

// residentSettings is the harness policy the Graph daemon owns.
//
// The provider retry and the context compaction belong to the daemon: it
// decides whether a failed send is retried and when the context is compacted,
// and the kernel must not do either behind its back.
//
// The compaction thresholds themselves are the daemon's too, and they are
// registered per model when a session opens. The kernel reads the policy at
// every use, so a policy registered for the model of the running session is
// in force for that session's next compaction - and for no other one.
func residentSettings() *harness.HarnessSettings {
	retry := harness.RetryPolicyPatch{Enabled: boolPointer(false)}
	compaction := harness.CompactionPolicyPatch{
		Enabled:          boolPointer(false),
		ReserveTokens:    intPointer(4096),
		KeepRecentTokens: intPointer(1024),
		BackgroundTokens: intPointer(0),
		ModelOverrides:   compactionPolicyOverrides(),
	}
	return &harness.HarnessSettings{Retry: &retry, Compaction: &compaction}
}

// compactionPolicies are the compaction thresholds the daemon decided, keyed
// by the model reference the kernel resolves them with.
var compactionPolicies = struct {
	sync.Mutex
	values map[string]durable.CompactionPolicyOverride
}{values: map[string]durable.CompactionPolicyOverride{}}

// RegisterCompactionPolicy records the compaction thresholds of one model.
//
// The reserve is the room the summary is written in and the keep-recent
// window is the part of the conversation that survives the compaction. The
// kernel derives the summary's own output budget from the reserve, so a
// reserve the daemon never chose is a summary that is cut short.
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

// compactionPolicyOverrides is the policy snapshot the kernel reads.
func compactionPolicyOverrides() map[string]durable.CompactionPolicyOverride {
	compactionPolicies.Lock()
	defer compactionPolicies.Unlock()
	out := make(map[string]durable.CompactionPolicyOverride, len(compactionPolicies.values))
	for model, override := range compactionPolicies.values {
		out[model] = override
	}
	return out
}

// extensionName is the name one session's extension is installed under.
//
// The name carries the identity, so two sessions of the same identity share
// one extension and two identities never collide.
func extensionName(identity string) string {
	return "graph-tools-" + digestOf(identity)
}

// ExtensionName is the name one identity's extension is installed under.
//
// The frozen execution names it, so a recovered turn finds the very same
// extension the interrupted one had registered.
func ExtensionName(identity string) string {
	return extensionName(identity)
}

// providerName is the name one session's provider is registered under.
func providerName(identity string) string {
	return "graph-" + digestOf(identity)
}

// digestOf is the short digest one identity is named by.
func digestOf(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}

// buildModel describes the model one session sends to.
//
// The model is the daemon's: the base URL, the key and the headers are the
// daemon's, and the kernel only carries the shape.
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

// apiOf is the provider protocol one model speaks.
//
// The daemon speaks the protocol itself, so the kernel only needs the name:
// the transcript and the message shapes follow it.
func apiOf(spec ModelSpec) ai.API {
	switch spec.API {
	case "anthropic-messages":
		return ai.APIAnthropicMessages
	case "openai-responses":
		return ai.APIOpenAIResponses
	}
	return ai.APIOpenAICompletions
}

// nowMillis is the wall clock in milliseconds.
func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// intPointer is one optional number.
func intPointer(value int) *int {
	return &value
}
