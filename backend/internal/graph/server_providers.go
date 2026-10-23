package graph

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

// ProviderCredentialKind is the provider-credential category shown by the
// settings wizard: a plain API key or a subscription access token. The wire
// value is always an environment variable name (secretRef); the secret itself
// never enters this module.
type ProviderCredentialKind string

const (
	// ProviderCredentialKindAPIKey is a plain vendor API key.
	ProviderCredentialKindAPIKey ProviderCredentialKind = "api-key"
	// ProviderCredentialKindSubscription is a subscription access token.
	ProviderCredentialKindSubscription ProviderCredentialKind = "subscription"
)

// ModelApiOpenAICompletions is the OpenAI-compatible chat transport.
const ModelApiOpenAICompletions ModelApi = "openai-completions"

// ModelApiAnthropicMessages is the Anthropic Messages transport.
const ModelApiAnthropicMessages ModelApi = "anthropic-messages"

// PlatformPresetRecord is one first-class provider Graph can configure with a
// single credential. Presets carry the endpoint and transport defaults so the
// wizard only has to collect a KEY (or subscription token), while `自定义`
// collects all fields.
type PlatformPresetRecord struct {
	OAuthProvider  string                 `json:"oauthProvider,omitempty"`
	ID             string                 `json:"id"`
	Label          string                 `json:"label"`
	API            ModelApi               `json:"api"`
	BaseURL        string                 `json:"baseUrl"`
	CredentialRef  string                 `json:"credentialRef"`
	CredentialKind ProviderCredentialKind `json:"credentialKind"`
	// ModelsListSupported is advisory only: it hints whether the vendor is known
	// to answer `<baseUrl>/models`. It never gates the probe - a wrong local
	// guess must not hide a vendor that really does list models - so it only
	// shapes copy. False means "expect a manual model id", not "do not request".
	ModelsListSupported bool              `json:"modelsListSupported"`
	Headers             map[string]string `json:"headers,omitempty"`
	DocsURL             *string           `json:"docsUrl,omitempty"`
	Notes               []string          `json:"notes"`
}

// CUSTOM_PLATFORM_ID is the fallback preset for any other OpenAI/Anthropic-
// compatible endpoint.
const CUSTOM_PLATFORM_ID = "custom"

// ProviderRoutes are the console provider endpoints. They are deliberately
// registered on the session-cookie `/api` face, NOT under `/api/app/*`: that
// prefix requires the desktop bridge token the browser console cannot read, so
// probing would never reach the daemon from the settings page.
type ProviderRoutes struct {
	List  string
	Probe string
}

// PROVIDER_ROUTES are the console provider endpoints.
var PROVIDER_ROUTES = ProviderRoutes{List: "/api/providers", Probe: "/api/providers/probe"}

// PLATFORM_PRESETS are the built-in supported platforms. `custom` is the
// fallback for any other OpenAI/Anthropic-compatible endpoint. Credential env
// names are shared with the usage adapters (src/server/usage.ts) so one key
// configures both.
var PLATFORM_PRESETS = []PlatformPresetRecord{
	{
		ID: "opencode-go", Label: "OpenCode Go", API: ModelApiOpenAICompletions,
		BaseURL: "https://opencode.ai/zen/go/v1", CredentialRef: "GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY",
		CredentialKind: ProviderCredentialKindSubscription, ModelsListSupported: true,
		Headers: map[string]string{"x-opencode-session": "graph-console"},
		DocsURL: providerStringPointer("https://opencode.ai/docs/zen"),
		Notes: []string{
			"订阅凭据；<baseUrl>/models 实测可用，自动列出订阅侧模型；端点拒绝时按原始错误提示并允许手动添加模型 id。",
			"所有请求自动附带 x-opencode-session。",
		},
	},
	{
		ID: "command-goat", Label: "Command Goat", API: ModelApiOpenAICompletions,
		BaseURL: "https://api.commandcode.ai/provider/v1", CredentialRef: "GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY",
		CredentialKind: ProviderCredentialKindSubscription, ModelsListSupported: true,
		Notes: []string{"订阅凭据；优先从 <baseUrl>/models 探测可用模型。"},
	},
	{
		ID: "grok", Label: "Grok", API: ModelApiOpenAICompletions,
		BaseURL: "https://api.x.ai/v1", CredentialRef: "GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN",
		CredentialKind: ProviderCredentialKindSubscription, ModelsListSupported: true,
		Notes: []string{"订阅访问令牌；使用 xAI 的 OpenAI 兼容端点。"},
	},
	{
		ID: "chatgpt", Label: "ChatGPT", API: ModelApiOpenAICompletions,
		BaseURL: "https://chatgpt.com/backend-api/codex", CredentialRef: "GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN",
		CredentialKind: ProviderCredentialKindSubscription, ModelsListSupported: true,
		Notes: []string{"ChatGPT/Codex 订阅访问令牌；后端以 Responses 形状返回，本轮按 Chat Completions 契约注册与探测，正式调用需在人工验收中确认。"},
	},
}

func init() {
	for _, template := range PROVIDER_TEMPLATES {
		ref := template.CredentialRefHint
		if template.ID == "deepseek" {
			ref = "GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY"
		}
		if template.ID == "custom" {
			ref = "GRAPH_PROVIDER_API_KEY"
		}
		preset := PlatformPresetRecord{ID: template.ID, Label: template.Label, API: ModelApi(template.API), BaseURL: template.BaseURL, CredentialRef: ref, CredentialKind: ProviderCredentialKindAPIKey, ModelsListSupported: true, DocsURL: stringPointer(template.DocsURL), Notes: template.Notes}
		if template.ID == "openrouter" {
			preset.OAuthProvider = "openrouter"
		}
		PLATFORM_PRESETS = append(PLATFORM_PRESETS, preset)
		PLATFORM_CREDENTIAL_REFS[preset.ID] = preset.CredentialRef
	}
}

// PLATFORM_CREDENTIAL_REFS maps every preset id to its environment variable.
var PLATFORM_CREDENTIAL_REFS = func() map[string]string {
	refs := map[string]string{}
	for _, preset := range PLATFORM_PRESETS {
		refs[preset.ID] = preset.CredentialRef
	}
	return refs
}()

func PlatformPreset(id string) *PlatformPresetRecord {
	for index := range PLATFORM_PRESETS {
		if PLATFORM_PRESETS[index].ID == id {
			return &PLATFORM_PRESETS[index]
		}
	}
	return nil
}

var providerSecretRefPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var providerHeaderNamePattern = regexp.MustCompile("^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")

// sanitizeProviderHeaders accepts only string header maps (values are bounded,
// names token-safe).
func sanitizeProviderHeaders(value any) map[string]string {
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil
	}
	headers := map[string]string{}
	for name, headerValue := range record {
		text, ok := headerValue.(string)
		if !ok || text == "" {
			continue
		}
		if !providerHeaderNamePattern.MatchString(name) {
			continue
		}
		headers[name] = text
	}
	if len(headers) == 0 {
		return nil
	}
	return headers
}

// isHttpURL reports whether the value is an absolute http(s) address.
func isHttpURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http:" && parsed.Scheme != "https:" {
		return false
	}
	return parsed.Host != ""
}

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

// ProviderCredentialView is one credential as the browser may see it.
type ProviderCredentialView struct {
	SecretRef          string  `json:"secretRef"`
	Resolved           bool    `json:"resolved"`
	DisplayName        *string `json:"displayName,omitempty"`
	SharedLimitGroupID *string `json:"sharedLimitGroupId,omitempty"`
}

// ProviderView is the credential view of the whole configuration.
type ProviderView struct {
	Credentials map[string]ProviderCredentialView `json:"credentials"`
}

// SanitizeProviderView is the credential view safe for the browser/API: names
// and resolved flags only, never a secret value. `secretValues` is read inside
// the daemon and dropped.
func SanitizeProviderView(config GraphConfig, secretValues map[string]string) ProviderView {
	credentials := map[string]ProviderCredentialView{}
	for id, credential := range config.Credentials {
		view := ProviderCredentialView{SecretRef: credential.SecretRef}
		if value, ok := secretValues[credential.SecretRef]; ok && strings.TrimSpace(value) != "" {
			view.Resolved = true
		}
		if credential.DisplayName != "" {
			name := credential.DisplayName
			view.DisplayName = &name
		}
		if credential.SharedLimitGroupId != "" {
			group := credential.SharedLimitGroupId
			view.SharedLimitGroupID = &group
		}
		credentials[id] = view
	}
	return ProviderView{Credentials: credentials}
}

// PlatformView is one platform in the settings wizard directory.
type PlatformView struct {
	OAuthProvider        string                 `json:"oauthProvider,omitempty"`
	ID                   string                 `json:"id"`
	Label                string                 `json:"label"`
	API                  ModelApi               `json:"api"`
	BaseURL              string                 `json:"baseUrl"`
	CredentialRef        string                 `json:"credentialRef"`
	CredentialKind       ProviderCredentialKind `json:"credentialKind"`
	ModelsListSupported  bool                   `json:"modelsListSupported"`
	Headers              map[string]string      `json:"headers,omitempty"`
	DocsURL              *string                `json:"docsUrl,omitempty"`
	Notes                []string               `json:"notes"`
	Custom               bool                   `json:"custom"`
	CredentialConfigured bool                   `json:"credentialConfigured"`
}

// PlatformCatalog is the platform directory for the settings wizard.
type PlatformCatalog struct {
	Platforms []PlatformView `json:"platforms"`
}

// PlatformCatalogView is the platform directory for the settings wizard, with
// per-platform credential resolution status derived from the daemon's merged
// secret view.
func PlatformCatalogView(secretValues map[string]string) PlatformCatalog {
	platforms := make([]PlatformView, 0, len(PLATFORM_PRESETS))
	for _, preset := range PLATFORM_PRESETS {
		view := PlatformView{
			ID: preset.ID, Label: preset.Label, API: preset.API, BaseURL: preset.BaseURL, OAuthProvider: preset.OAuthProvider,
			CredentialRef: preset.CredentialRef, CredentialKind: preset.CredentialKind,
			ModelsListSupported: preset.ModelsListSupported, Headers: preset.Headers,
			DocsURL: preset.DocsURL, Notes: preset.Notes, Custom: preset.ID == CUSTOM_PLATFORM_ID,
		}
		if value, ok := secretValues[preset.CredentialRef]; ok && strings.TrimSpace(value) != "" {
			view.CredentialConfigured = true
		}
		platforms = append(platforms, view)
	}
	return PlatformCatalog{Platforms: platforms}
}

// ProviderRegistration is one provider endpoint the runtime may dispatch to.
// The credential value never leaves the daemon.
type ProviderRegistration struct {
	BaseURL string
	API     ModelApi
	APIKey  string
	Models  []ConfiguredModel
	Headers map[string]string
}

// providerStringPointer returns a pointer to the value.
func providerStringPointer(value string) *string { return &value }
