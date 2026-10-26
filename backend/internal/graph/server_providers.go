package graph

import (
	"net/url"
	"regexp"
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
	// url.URL.Scheme never carries the colon, so it is compared without one.
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return parsed.Host != ""
}
