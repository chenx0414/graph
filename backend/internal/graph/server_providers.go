package graph

import (
	"net/url"
	"regexp"
)

type ProviderCredentialKind string

const (
	ProviderCredentialKindAPIKey       ProviderCredentialKind = "api-key"
	ProviderCredentialKindSubscription ProviderCredentialKind = "subscription"
)

const ModelApiOpenAICompletions ModelApi = "openai-completions"

const ModelApiOpenAIResponses ModelApi = "openai-responses"

const ModelApiAnthropicMessages ModelApi = "anthropic-messages"

type PlatformPresetRecord struct {
	OAuthProvider       string                 `json:"oauthProvider,omitempty"`
	ID                  string                 `json:"id"`
	Label               string                 `json:"label"`
	API                 ModelApi               `json:"api"`
	BaseURL             string                 `json:"baseUrl"`
	CredentialRef       string                 `json:"credentialRef"`
	CredentialKind      ProviderCredentialKind `json:"credentialKind"`
	ModelsListSupported bool                   `json:"modelsListSupported"`
	Headers             map[string]string      `json:"headers,omitempty"`
	DocsURL             *string                `json:"docsUrl,omitempty"`
	Notes               []string               `json:"notes"`
	Unsupported         bool                   `json:"unsupported,omitempty"`
}

const CUSTOM_PLATFORM_ID = "custom"

type ProviderRoutes struct {
	List  string
	Probe string
}

var PROVIDER_ROUTES = ProviderRoutes{List: "/api/providers", Probe: "/api/providers/probe"}

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
		ID: "grok", Label: "Grok", OAuthProvider: "xai", API: ModelApiOpenAICompletions,
		BaseURL: "https://api.x.ai/v1", CredentialRef: "GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN",
		CredentialKind: ProviderCredentialKindSubscription, ModelsListSupported: true,
		Notes: []string{
			"订阅访问令牌；可点「使用 xAI 账号登录」走设备码授权，也可以直接粘贴访问令牌。",
			"设备码登录会写访问令牌与一个 `<credentialRef>_REFRESH` 伴随条目，访问令牌到期前自动刷新。",
		},
	},
	{
		ID: "chatgpt", Label: "ChatGPT", API: ModelApiOpenAIResponses,
		BaseURL: "https://chatgpt.com/backend-api/codex", CredentialRef: "GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN",
		CredentialKind: ProviderCredentialKindSubscription, ModelsListSupported: true,
		Unsupported: true,
		Notes: []string{
			"已不再提供：Codex 后端只按 Responses 形状（input 项目、扁平工具、response.* 事件）应答，但它在握手后直接 EOF（连接早关），本仓的流式解析器不接受这条事件流，所以这个端点上没有任何一轮能跑完。",
			"配置里仍写该平台的模型条目会被拒绝；请改用它的传输 fallback：grok:grok-4.5（api openai-completions，baseUrl https://api.x.ai/v1）。",
		},
	},
}

const unsupportedPlatformReason = "the Codex endpoint closes the connection before answering (EOF) and this runtime " +
	"does not accept its openai-responses event stream, so no turn can complete on it; use grok (grok:grok-4.5) instead"

var unsupportedPlatforms = map[string]string{
	"chatgpt": unsupportedPlatformReason,
}

func UnsupportedPlatformReason(id string) string { return unsupportedPlatforms[id] }

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

func isHttpURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return parsed.Host != ""
}
