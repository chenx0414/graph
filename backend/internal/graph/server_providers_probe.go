package graph

import (
	"strings"

	"encoding/json"
)

type ProbeRequest struct {
	RequestID   string           `json:"requestId"`
	Provider    ResolvedProvider `json:"provider"`
	ModelID     *string          `json:"modelId,omitempty"`
	ProbeModels *bool            `json:"probeModels,omitempty"`
}

func ShouldProbeModels(probeModels *bool) bool {
	return probeModels == nil || *probeModels
}

type ProbeRequestValidation struct {
	OK      bool
	Request ProbeRequest
	Errors  []ProviderDraftError
}

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

type ProbeTarget struct {
	BaseURL string   `json:"baseUrl"`
	API     ModelApi `json:"api"`
	APIKey  *string           `json:"apiKey,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type HttpRequestSpec struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body,omitempty"`
}

func joinProviderURL(baseURL, suffix string) string {
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(suffix, "/")
}

func AuthHeaders(target ProbeTarget) map[string]string {
	if target.APIKey == nil {
		return map[string]string{}
	}
	if target.API == ModelApiAnthropicMessages {
		return map[string]string{"x-api-key": *target.APIKey, "anthropic-version": "2023-06-01"}
	}
	return map[string]string{"authorization": "Bearer " + *target.APIKey}
}

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

func BuildVerifyRequest(target ProbeTarget, modelID string) HttpRequestSpec {
	anthropic := target.API == ModelApiAnthropicMessages
	responses := target.API == ModelApiOpenAIResponses
	path := "chat/completions"
	if anthropic {
		path = "messages"
	}
	if responses {
		path = "responses"
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
	if responses {
		payload = map[string]any{
			"model": modelID, "stream": false, "store": false, "max_output_tokens": 16,
			"input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "ping"}}}},
		}
	}
	if !anthropic && !responses {
		payload["stream"] = false
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	body := string(raw)
	return HttpRequestSpec{Method: "POST", URL: joinProviderURL(target.BaseURL, path), Headers: headers, Body: &body}
}
