package graph

import (
	"encoding/json"
	"strings"
)

// ProbeRequest is one probe request the console sends.
type ProbeRequest struct {
	RequestID   string           `json:"requestId"`
	Provider    ResolvedProvider `json:"provider"`
	ModelID     *string          `json:"modelId,omitempty"`
	ProbeModels *bool            `json:"probeModels,omitempty"`
}

// ShouldProbeModels reports whether a probe should ask the vendor for its
// model list. The directory's `modelsListSupported` flag is advisory copy only
// and must never gate the request: only an explicit `probeModels:false`
// suppresses it. The vendor's real response is the source of truth - a
// rejection surfaces its own error text and the wizard can still add a model id
// by hand.
func ShouldProbeModels(probeModels *bool) bool {
	return probeModels == nil || *probeModels
}

// ProbeRequestValidation is the outcome of parsing a probe body.
type ProbeRequestValidation struct {
	OK      bool
	Request ProbeRequest
	Errors  []ProviderDraftError
}

// ValidateProbeRequest parses a probe body. `requestId` is the idempotency
// key the console POST must always carry; the provider draft lives under
// `provider` (a flat body is also accepted for convenience) and is validated
// by ValidateProviderDraft.
func ValidateProbeRequest(input any) ProbeRequestValidation {
	body := map[string]any{}
	if record, ok := input.(map[string]any); ok && record != nil {
		body = record
	}
	errors := []ProviderDraftError{}

	requestID := ""
	hasRequestID := false
	if value, ok := body["requestId"].(string); ok && strings.TrimSpace(value) != "" {
		requestID = strings.TrimSpace(value)
		hasRequestID = true
	}
	if !hasRequestID {
		errors = append(errors, ProviderDraftError{Field: "requestId", Message: "requestId is required"})
	}

	draft := body["provider"]
	if draft == nil {
		draft = body
	}
	validated := ValidateProviderDraft(draft)
	if !validated.OK {
		errors = append(errors, validated.Errors...)
	}
	if len(errors) > 0 || !hasRequestID || !validated.OK {
		return ProbeRequestValidation{OK: false, Errors: errors}
	}

	request := ProbeRequest{RequestID: requestID, Provider: validated.Provider}
	if value, ok := body["modelId"].(string); ok && strings.TrimSpace(value) != "" {
		modelID := strings.TrimSpace(value)
		request.ModelID = &modelID
	}
	if value, ok := body["probeModels"].(bool); ok {
		probeModels := value
		request.ProbeModels = &probeModels
	}
	return ProbeRequestValidation{OK: true, Request: request}
}

// ProbeTarget is the provider endpoint a probe talks to.
type ProbeTarget struct {
	BaseURL string   `json:"baseUrl"`
	API     ModelApi `json:"api"`
	// APIKey is the resolved secret value; present only inside the daemon
	// during a probe.
	APIKey  *string           `json:"apiKey,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// HttpRequestSpec is one outbound request the probe makes.
type HttpRequestSpec struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body,omitempty"`
}

// joinProviderURL joins a base URL and a path with exactly one separator.
func joinProviderURL(baseURL, suffix string) string {
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(suffix, "/")
}

// AuthHeaders are the auth headers per transport. Anthropic uses x-api-key +
// version; the OpenAI-compatible transports use a bearer token.
func AuthHeaders(target ProbeTarget) map[string]string {
	if target.APIKey == nil {
		return map[string]string{}
	}
	if target.API == ModelApiAnthropicMessages {
		return map[string]string{"x-api-key": *target.APIKey, "anthropic-version": "2023-06-01"}
	}
	return map[string]string{"authorization": "Bearer " + *target.APIKey}
}

// BuildModelsRequest is the model-listing request for the provider
// (OpenAI-compatible `<base>/models`, Anthropic-compatible `<base>/models`).
// Pure: builds the shape only.
func BuildModelsRequest(target ProbeTarget) HttpRequestSpec {
	headers := map[string]string{"accept": "application/json"}
	for name, value := range AuthHeaders(target) {
		headers[name] = value
	}
	for name, value := range target.Headers {
		headers[name] = value
	}
	return HttpRequestSpec{Method: "GET", URL: joinProviderURL(target.BaseURL, "models"), Headers: headers}
}

// BuildVerifyRequest is the minimal chat request used to prove a credential +
// model work.
func BuildVerifyRequest(target ProbeTarget, modelID string) HttpRequestSpec {
	anthropic := target.API == ModelApiAnthropicMessages
	path := "chat/completions"
	if anthropic {
		path = "messages"
	}
	headers := map[string]string{"content-type": "application/json", "accept": "application/json"}
	for name, value := range AuthHeaders(target) {
		headers[name] = value
	}
	for name, value := range target.Headers {
		headers[name] = value
	}
	payload := map[string]any{
		"model": modelID, "max_tokens": 1,
		"messages": []any{map[string]any{"role": "user", "content": "ping"}},
	}
	if !anthropic {
		payload["stream"] = false
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	body := string(raw)
	return HttpRequestSpec{Method: "POST", URL: joinProviderURL(target.BaseURL, path), Headers: headers, Body: &body}
}
