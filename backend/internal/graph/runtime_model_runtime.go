package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"

	"bytes"
)

type piModelView struct {
	Id               string             `json:"id"`
	Name             string             `json:"name"`
	Provider         string             `json:"provider"`
	Api              ModelApi           `json:"api"`
	BaseUrl          string             `json:"baseUrl"`
	Reasoning        bool               `json:"reasoning"`
	Input            []ModelInput       `json:"input"`
	ContextWindow    int                `json:"contextWindow"`
	MaxTokens        int                `json:"maxTokens"`
	ThinkingLevelMap map[string]*string `json:"thinkingLevelMap,omitempty"`
	Cost             ModelCost          `json:"cost"`
	Headers          map[string]string  `json:"headers,omitempty"`
}

// ToPiModel builds the model the transport sends with.
func ToPiModel(entry ModelEntry) piModelView {
	headers := ModelRequestHeaders(entry)
	thinkingLevelMap := ThinkingLevelMapFor(entry)
	model := piModelView{
		Id:       entry.Id,
		Name:     entry.Id,
		Provider: entry.Provider,
		Api:      entry.Api,
		BaseUrl:  entry.BaseUrl,
		// Every model is treated as thinking-capable: the console no longer asks,
		// and the SDK's own supported-level rule short-circuits to `off` when this
		// flag is false. A legacy `reasoning: false` entry is therefore ignored.
		Reasoning:     true,
		Input:         []ModelInput{"text"},
		ContextWindow: entry.ContextWindow,
		MaxTokens:     entry.MaxTokens,
		// Pi's Model.cost is required numeric metadata; Graph billing uses catalog cost, never this placeholder.
		Cost: ModelCost{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0},
	}
	if entry.ModelId != "" {
		model.Id = entry.ModelId
	}
	if len(entry.Input) > 0 {
		model.Input = append([]ModelInput{}, entry.Input...)
	}
	if thinkingLevelMap != nil {
		// A model takes only the effort levels its catalog entry names; the SDK maps
		// Pi's level onto the provider's own value at the wire.
		model.ThinkingLevelMap = map[string]*string(thinkingLevelMap)
	}
	if entry.Cost != nil {
		model.Cost = *entry.Cost
	}
	if headers != nil {
		// Gateway routing headers (for example x-opencode-session) must travel
		// with every provider request.
		model.Headers = headers
	}
	return model
}

// ModelRuntime is the provider registry the daemon keeps for the models it may dispatch.
//
// The Pi SDK's ModelRuntime held the same registrations and dispatched them through the SDK's
// provider clients. The SDK is not linked here, so the registry is Graph's own and a provider call
// is one HTTP request through the shared HTTPClient (RULEBOOK §7): the same request shape, the
// same auth and the same streaming flag, and the e2e OpenRouter rewrite applies exactly as it
// does to every other provider request.
type ModelRuntime struct {
	mu        sync.RWMutex
	providers map[string]ProviderRegistration
}

// NewModelRuntime opens an empty provider registry.
func NewModelRuntime() *ModelRuntime {
	return &ModelRuntime{providers: map[string]ProviderRegistration{}}
}

// RegisterProvider registers or replaces one provider endpoint.
//
// Re-registering the same provider name replaces its endpoint/key, so a saved rotation applies to
// the next session opened for this provider.
func (m *ModelRuntime) RegisterProvider(name string, reg ProviderRegistration) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.providers == nil {
		m.providers = map[string]ProviderRegistration{}
	}
	m.providers[name] = reg
}

// Provider is one registered provider endpoint.
func (m *ModelRuntime) Provider(name string) (ProviderRegistration, bool) {
	if m == nil {
		return ProviderRegistration{}, false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	reg, ok := m.providers[name]
	return reg, ok
}

// Providers is the registered provider names, sorted.
func (m *ModelRuntime) Providers() []string {
	if m == nil {
		return []string{}
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	names := make([]string, 0, len(m.providers))
	for name := range m.providers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ProviderRequest is one provider call.
type ProviderRequest struct {
	Model    string
	Messages []any
	System   *string
	Stream   bool
	Options  map[string]any
}

// ProviderResponse is the provider's answer.
type ProviderResponse struct {
	Status int
	Header http.Header
	Body   []byte
}

// Send performs one provider call against a registered endpoint.
//
// The request shape is the provider's own: an OpenAI-compatible endpoint takes
// `{model, messages, stream}` and an Anthropic endpoint takes
// `{model, max_tokens, messages, system, stream}`. The key travels as `Authorization: Bearer` for
// the former and `x-api-key` for the latter, and the registered headers travel with every call.
func (m *ModelRuntime) Send(provider string, request ProviderRequest) (*ProviderResponse, error) {
	reg, ok := m.Provider(provider)
	if !ok {
		return nil, errors.New("Unknown provider: " + provider)
	}
	if reg.BaseURL == "" {
		return nil, errors.New("Provider " + provider + " has no baseUrl")
	}
	body, err := providerRequestBody(reg.API, request)
	if err != nil {
		return nil, err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, providerEndpoint(reg.BaseURL, reg.API), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, value := range providerRequestHeaders(reg) {
		httpRequest.Header.Set(key, value)
	}
	httpRequest.Header.Set("content-type", "application/json")
	response, err := HTTPClient.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := ReadBody(response.Body)
	if err != nil {
		return nil, err
	}
	return &ProviderResponse{Status: response.StatusCode, Header: response.Header, Body: payload}, nil
}

// providerEndpoint is the path a provider API takes.
func providerEndpoint(baseURL string, api ModelApi) string {
	trimmed := strings.TrimRight(baseURL, "/")
	switch string(api) {
	case "anthropic-messages":
		return trimmed + "/messages"
	default:
		return trimmed + "/chat/completions"
	}
}

// providerRequestHeaders are the auth and routing headers of one provider call.
func providerRequestHeaders(reg ProviderRegistration) map[string]string {
	headers := map[string]string{}
	for key, value := range reg.Headers {
		headers[key] = value
	}
	explicit := func(name string) bool {
		for key := range headers {
			if strings.EqualFold(key, name) {
				return true
			}
		}
		return false
	}
	if reg.APIKey != "" {
		if string(reg.API) == "anthropic-messages" {
			if !explicit("x-api-key") {
				headers["x-api-key"] = reg.APIKey
			}
			if !explicit("anthropic-version") {
				headers["anthropic-version"] = "2023-06-01"
			}
		} else {
			if !explicit("authorization") {
				headers["authorization"] = "Bearer " + reg.APIKey
			}
		}
	}
	return headers
}

// providerRequestBody is the wire body of one provider call, in the provider's own field order.
func providerRequestBody(api ModelApi, request ProviderRequest) ([]byte, error) {
	if string(api) == "anthropic-messages" {
		payload := map[string]any{
			"model":    request.Model,
			"messages": request.Messages,
		}
		if limit, ok := request.Options["maxTokens"]; ok {
			payload["max_tokens"] = limit
		}
		if request.System != nil {
			payload["system"] = *request.System
		}
		payload["stream"] = request.Stream
		return json.Marshal(payload)
	}
	payload := map[string]any{
		"model":    request.Model,
		"messages": request.Messages,
		"stream":   request.Stream,
	}
	for key, value := range request.Options {
		if key == "maxTokens" {
			payload["max_tokens"] = value
			continue
		}
		payload[key] = value
	}
	return json.Marshal(payload)
}

// ToolResultText is the words a tool result carries, as the model saw them.
//
// Pi hands a tool result back as `{ content: [{ type: 'text', text }] }`, and on a failure the reason
// is in that text and nowhere else. A record that keeps only `isError` is a boolean nobody can
// diagnose with, so the reason is kept beside it, bounded - a failing command can return megabytes.
func ToolResultText(result any, limit int) string {
	if limit <= 0 {
		limit = 2_000
	}
	record, _ := result.(map[string]any)
	content, _ := record["content"].([]any)
	parts := []string{}
	for _, item := range content {
		part, _ := item.(map[string]any)
		if part["type"] != "text" {
			continue
		}
		text, ok := part["text"].(string)
		if !ok {
			continue
		}
		parts = append(parts, text)
	}
	joined := strings.TrimSpace(strings.Join(parts, "\n"))
	runes := []rune(joined)
	if len(runes) > limit {
		return string(runes[:limit]) + "…（已截断）"
	}
	return joined
}

// summarizeToolCall is the one-line summary of a tool call for the conversation activity stream.
func summarizeToolCall(name string, args any) string {
	body, _ := args.(map[string]any)
	if body == nil {
		body = map[string]any{}
	}
	target := func(key string) string {
		value, _ := body[key].(string)
		return value
	}
	first := func(values ...string) string {
		for _, value := range values {
			if value != "" {
				return value
			}
		}
		return ""
	}
	join := func(values ...string) string {
		kept := []string{}
		for _, value := range values {
			if value != "" {
				kept = append(kept, value)
			}
		}
		return strings.Join(kept, " ")
	}
	summary := name
	switch {
	case name == "bash":
		summary = first(target("command"), name)
	case name == "grep" || name == "rg":
		summary = first(join(target("pattern"), target("path")), name)
	case name == "ls" || name == "glob":
		summary = first(target("path"), target("pattern"), name)
	case name == "read" || name == "write_file" || name == "list_dir":
		summary = first(target("path"), name)
	case name == "artifact_publish":
		summary = first(join(target("namespace"), target("name")), name)
	case name == "artifact_read" || name == "artifact_retire":
		version := ""
		if number, ok := body["version"].(float64); ok {
			version = fmt.Sprintf("@%v", number)
		}
		summary = first(target("artifactId"), name) + version
	case name == "artifact_list":
		summary = first(target("namespace"), target("prefix"), name)
	case name == "run_command":
		values := []string{target("command")}
		if list, ok := body["args"].([]any); ok {
			for _, item := range list {
				values = append(values, fmt.Sprintf("%v", item))
			}
		}
		summary = join(values...)
	case name == "fetch":
		summary = first(target("url"), name)
	case name == "propose_graph" || name == "confirm_draft":
		summary = "draft"
	case name == "validate_proposal":
		summary = "validation"
	case name == "get_graph_state":
		summary = "current graph"
	case name == "get_task_status":
		summary = "task status"
	case name == "bind_project":
		summary = first(target("projectId"), name)
	case strings.HasPrefix(name, "git_"):
		summary = join(name, first(target("path"), target("ref")))
	case name == "apply_rsi_change":
		summary = first(target("title"), "self-improvement")
	case name == "inspect_rsi_status":
		summary = "self-improvement status"
	}
	runes := []rune(summary)
	if len(runes) > 160 {
		return string(runes[:157]) + "..."
	}
	return summary
}

// combineKnownUsage adds two usage reports when both are known.
func combineKnownUsage(base *TokenUsage, extra *TokenUsage) *TokenUsage {
	if base == nil || extra == nil {
		return base
	}
	source := MergeUsageSource(UsageSourceOf(base), UsageSourceOf(extra))
	return &TokenUsage{
		Input:       base.Input + extra.Input,
		Output:      base.Output + extra.Output,
		CacheRead:   base.CacheRead + extra.CacheRead,
		CacheWrite:  base.CacheWrite + extra.CacheWrite,
		UsageSource: &[]string{string(source)}[0],
	}
}
