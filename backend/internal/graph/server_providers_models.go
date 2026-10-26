package graph

import (
	"strings"

	"encoding/json"
)

// ProviderModelSummary is one model the vendor lists.
type ProviderModelSummary struct {
	ID   string  `json:"id"`
	Name *string `json:"name,omitempty"`
}

// ModelsResponse is the parsed `<base>/models` reply. A non-2xx reply always
// carries the vendor's original text in Error.
type ModelsResponse struct {
	Models []ProviderModelSummary
	Error  string
}

// VendorErrorText extracts the vendor's own error text. Never generalized: a
// JSON error body contributes its message, a plain-text body is preserved
// verbatim.
func VendorErrorText(body any, status int) string {
	switch value := body.(type) {
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			parsed, ok := tryProviderJSON(trimmed)
			if ok {
				if _, isText := parsed.(string); !isText {
					return VendorErrorText(parsed, status)
				}
			}
			return trimmed
		}
	case map[string]any:
		if message, ok := value["error"].(string); ok && strings.TrimSpace(message) != "" {
			return strings.TrimSpace(message)
		}
		if nested, ok := value["error"].(map[string]any); ok {
			if message, ok := nested["message"].(string); ok && strings.TrimSpace(message) != "" {
				return strings.TrimSpace(message)
			}
		}
		for _, key := range []string{"message", "detail", "msg", "error_description"} {
			if message, ok := value[key].(string); ok && strings.TrimSpace(message) != "" {
				return strings.TrimSpace(message)
			}
		}
		raw, err := json.Marshal(value)
		if err == nil {
			text := string(raw)
			if text != "" && text != "{}" && text != "null" {
				return text
			}
		}
	}
	return "HTTP " + itoa(status)
}

// tryProviderJSON parses JSON text. The second result reports success.
func tryProviderJSON(value string) (any, bool) {
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, false
	}
	return parsed, true
}

// readProviderModelRow reads one row of a vendor model list.
func readProviderModelRow(row any) *ProviderModelSummary {
	if text, ok := row.(string); ok {
		if strings.TrimSpace(text) == "" {
			return nil
		}
		return &ProviderModelSummary{ID: strings.TrimSpace(text)}
	}
	record, ok := row.(map[string]any)
	if !ok || record == nil {
		return nil
	}
	id := ""
	for _, key := range []string{"id", "model", "slug", "name"} {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			id = value
			break
		}
	}
	if id == "" {
		return nil
	}
	name := ""
	for _, key := range []string{"name", "display_name", "displayName"} {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			name = value
			break
		}
	}
	summary := &ProviderModelSummary{ID: strings.TrimSpace(id)}
	if name != "" && strings.TrimSpace(name) != strings.TrimSpace(id) {
		trimmed := strings.TrimSpace(name)
		summary.Name = &trimmed
	}
	return summary
}

// ParseModelsResponse parses `<base>/models`. Non-2xx always yields the
// vendor's original text.
func ParseModelsResponse(provider ProbeTarget, status int, body any) ModelsResponse {
	if status < 200 || status >= 300 {
		return ModelsResponse{Error: VendorErrorText(body, status)}
	}
	rows := []any{}
	switch value := body.(type) {
	case []any:
		rows = value
	case map[string]any:
		for _, key := range []string{"data", "models", "items"} {
			if list, ok := value[key].([]any); ok {
				rows = list
				break
			}
		}
	}
	models := []ProviderModelSummary{}
	seen := map[string]bool{}
	for _, row := range rows {
		model := readProviderModelRow(row)
		if model == nil || seen[model.ID] {
			continue
		}
		seen[model.ID] = true
		models = append(models, *model)
	}
	return ModelsResponse{Models: models}
}

// VerifyResponse is the parsed minimal chat reply.
type VerifyResponse struct {
	OK     bool   `json:"ok"`
	Status int    `json:"status"`
	Error  string `json:"error,omitempty"`
}

// ParseVerifyResponse parses the minimal chat response. Failures keep the
// vendor's raw wording.
func ParseVerifyResponse(status int, body any) VerifyResponse {
	if status >= 200 && status < 300 {
		return VerifyResponse{OK: true, Status: status}
	}
	return VerifyResponse{OK: false, Status: status, Error: VendorErrorText(body, status)}
}
