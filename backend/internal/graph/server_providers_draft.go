package graph

import (
	"strings"
)

// ResolvedProvider is a fully resolved provider draft: every field the probe
// and save paths need.
type ResolvedProvider struct {
	ID                  string                 `json:"id"`
	Label               string                 `json:"label"`
	API                 ModelApi               `json:"api"`
	BaseURL             string                 `json:"baseUrl"`
	CredentialRef       string                 `json:"credentialRef"`
	CredentialKind      ProviderCredentialKind `json:"credentialKind"`
	ModelsListSupported bool                   `json:"modelsListSupported"`
	Headers             map[string]string      `json:"headers,omitempty"`
	Custom              bool                   `json:"custom"`
}

// ProviderDraftBody is the provider draft as the settings page sends it in a
// probe/save request. Field names are the shared contract: the display name is
// `label` and the credential reference is `credentialRef` (never `name` /
// `secretRef`).
type ProviderDraftBody struct {
	ID                  *string           `json:"id"`
	Label               *string           `json:"label"`
	BaseURL             *string           `json:"baseUrl"`
	API                 *string           `json:"api"`
	CredentialRef       *string           `json:"credentialRef"`
	Headers             map[string]string `json:"headers"`
	ModelsListSupported *bool             `json:"modelsListSupported"`
}

// ProviderDraftError names the field that failed validation.
type ProviderDraftError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// ProviderDraftValidation is the outcome of validating a provider draft.
type ProviderDraftValidation struct {
	OK       bool
	Provider ResolvedProvider
	Errors   []ProviderDraftError
}

// ValidateProviderDraft validates a provider draft coming from the settings
// page. A supported platform only needs a credential reference (label/baseUrl/
// api default from the directory); `自定义` must supply label + baseUrl +
// compatibility api + credentialRef itself.
func ValidateProviderDraft(input any) ProviderDraftValidation {
	draft := map[string]any{}
	if record, ok := input.(map[string]any); ok && record != nil {
		draft = record
	}

	rawID := ""
	hasRawID := false
	if value, ok := draft["id"].(string); ok && strings.TrimSpace(value) != "" {
		rawID = strings.TrimSpace(value)
		hasRawID = true
	}
	var preset *PlatformPresetRecord
	if hasRawID {
		preset = PlatformPreset(rawID)
	}
	custom := preset == nil || preset.ID == CUSTOM_PLATFORM_ID
	// The `custom` preset only carries UI hints; its required fields must come
	// from the draft so an explicit compatibility format is always chosen.
	errors := []ProviderDraftError{}

	if hasRawID && preset == nil && rawID != CUSTOM_PLATFORM_ID {
		errors = append(errors, ProviderDraftError{Field: "id", Message: "未知平台 \"" + rawID + "\""})
	}

	rawBaseURL := ""
	if value, ok := draft["baseUrl"].(string); ok {
		rawBaseURL = strings.TrimSpace(value)
	}
	baseURL := rawBaseURL
	if baseURL == "" && preset != nil && !custom {
		baseURL = preset.BaseURL
	}
	if baseURL == "" {
		errors = append(errors, ProviderDraftError{Field: "baseUrl", Message: "自定义厂商必须填写 Base URL"})
	} else if !isHttpURL(baseURL) {
		errors = append(errors, ProviderDraftError{Field: "baseUrl", Message: "Base URL 必须是 http(s) 绝对地址"})
	}

	rawAPI := ""
	hasRawAPI := false
	if value, ok := draft["api"].(string); ok && strings.TrimSpace(value) != "" {
		rawAPI = strings.TrimSpace(value)
		hasRawAPI = true
	}
	api := ""
	hasAPI := false
	if hasRawAPI {
		api = rawAPI
		hasAPI = true
	} else if preset != nil && !custom {
		api = string(preset.API)
		hasAPI = true
	}
	if !hasAPI || (api != string(ModelApiOpenAICompletions) && api != string(ModelApiAnthropicMessages)) {
		errors = append(errors, ProviderDraftError{Field: "api", Message: "兼容格式必须是 openai-completions 或 anthropic-messages"})
	}

	rawLabel := ""
	hasRawLabel := false
	if value, ok := draft["label"].(string); ok && strings.TrimSpace(value) != "" {
		rawLabel = strings.TrimSpace(value)
		hasRawLabel = true
	}
	label := ""
	if hasRawLabel {
		label = rawLabel
	} else if preset != nil && !custom {
		label = preset.Label
	}
	if label == "" {
		errors = append(errors, ProviderDraftError{Field: "label", Message: "自定义厂商必须填写厂商名"})
	}

	rawCredentialRef := ""
	hasRawCredentialRef := false
	if value, ok := draft["credentialRef"].(string); ok && strings.TrimSpace(value) != "" {
		rawCredentialRef = strings.TrimSpace(value)
		hasRawCredentialRef = true
	}
	credentialRef := ""
	if hasRawCredentialRef {
		credentialRef = rawCredentialRef
	} else if preset != nil {
		credentialRef = preset.CredentialRef
	}
	if credentialRef == "" {
		errors = append(errors, ProviderDraftError{Field: "credentialRef", Message: "需要凭据引用（环境变量名或钥匙串条目）"})
	} else if !providerSecretRefPattern.MatchString(credentialRef) {
		errors = append(errors, ProviderDraftError{Field: "credentialRef", Message: "credentialRef 必须是环境变量名"})
	}

	headers := map[string]string{}
	if preset != nil {
		for name, value := range preset.Headers {
			headers[name] = value
		}
	}
	for name, value := range sanitizeProviderHeaders(draft["headers"]) {
		headers[name] = value
	}
	modelsListSupported := true
	if value, ok := draft["modelsListSupported"].(bool); ok {
		modelsListSupported = value
	} else if preset != nil {
		modelsListSupported = preset.ModelsListSupported
	}

	if len(errors) > 0 {
		return ProviderDraftValidation{OK: false, Errors: errors}
	}
	resolved := ResolvedProvider{
		ID: CUSTOM_PLATFORM_ID, Label: label, API: ModelApi(api), BaseURL: baseURL,
		CredentialRef: credentialRef, CredentialKind: ProviderCredentialKindAPIKey,
		ModelsListSupported: modelsListSupported, Custom: custom,
	}
	if hasRawID {
		resolved.ID = rawID
	}
	if preset != nil {
		resolved.CredentialKind = preset.CredentialKind
	}
	if len(headers) > 0 {
		resolved.Headers = headers
	}
	return ProviderDraftValidation{OK: true, Provider: resolved}
}
