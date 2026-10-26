package graph

type ProviderTemplateModel struct {
	ID            string        `json:"id"`
	Grade         string        `json:"grade"`
	ContextWindow int           `json:"contextWindow"`
	MaxTokens     int           `json:"maxTokens"`
	Input         []string      `json:"input,omitempty"`
	Cost          *ModelCost    `json:"cost,omitempty"`
	Pricing       *ModelPricing `json:"pricing,omitempty"`
}

type ProviderTemplateRecord struct {
	ID                string                  `json:"id"`
	Label             string                  `json:"label"`
	API               string                  `json:"api"`
	BaseURL           string                  `json:"baseUrl"`
	CredentialRefHint string                  `json:"credentialRefHint"`
	DocsURL           string                  `json:"docsUrl"`
	Notes             []string                `json:"notes"`
	Models            []ProviderTemplateModel `json:"models"`
}

var PROVIDER_TEMPLATES = []ProviderTemplateRecord{
	{
		ID: "openai", Label: "OpenAI", API: "openai-completions",
		BaseURL: "https://api.openai.com/v1", CredentialRefHint: "OPENAI_API_KEY",
		DocsURL: "https://platform.openai.com/docs/api-reference/chat",
		Notes:   []string{"API key 登录；本轮只启用 Chat Completions 传输。仅支持 Responses 的模型需另行验收后才会标注可用。"},
		Models: []ProviderTemplateModel{
			{ID: "gpt-4o", Grade: "highest", ContextWindow: 128000, MaxTokens: 16384, Input: []string{"text", "image"}},
			{ID: "gpt-4o-mini", Grade: "medium", ContextWindow: 128000, MaxTokens: 16384, Input: []string{"text", "image"}},
		},
	},
	{
		ID: "anthropic", Label: "Anthropic", API: "anthropic-messages",
		// The Messages transport appends /v1/messages to the host root.
		BaseURL: "https://api.anthropic.com", CredentialRefHint: "ANTHROPIC_API_KEY",
		DocsURL: "https://platform.claude.com/docs/en/api/overview",
		Notes:   []string{"API key 登录；使用原生 Messages 传输，不复用 OpenAI 请求格式。"},
		Models: []ProviderTemplateModel{
			{ID: "claude-sonnet-4-5", Grade: "highest", ContextWindow: 200000, MaxTokens: 8192, Input: []string{"text", "image"}},
			{ID: "claude-haiku-4-5", Grade: "medium", ContextWindow: 200000, MaxTokens: 8192, Input: []string{"text", "image"}},
		},
	},
	{
		ID: "gemini", Label: "Google Gemini", API: "openai-completions",
		BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai", CredentialRefHint: "GEMINI_API_KEY",
		DocsURL: "https://ai.google.dev/gemini-api/docs/openai",
		Notes:   []string{"使用官方 OpenAI 兼容模式；工具与用量按兼容层实际行为验收后才算可用。"},
		Models: []ProviderTemplateModel{
			{ID: "gemini-2.0-flash", Grade: "medium", ContextWindow: 1048576, MaxTokens: 8192, Input: []string{"text", "image"}},
		},
	},
	{
		ID: "deepseek", Label: "DeepSeek", API: "openai-completions",
		BaseURL: "https://api.deepseek.com/v1", CredentialRefHint: "DEEPSEEK_API_KEY",
		DocsURL: "https://api-docs.deepseek.com/guides/function_calling",
		Notes:   []string{"使用官方兼容传输；以厂商实际支持的字段与契约为准。"},
		Models: []ProviderTemplateModel{
			{ID: "deepseek-flash", Grade: "high", ContextWindow: 1048576, MaxTokens: 65536},
			{ID: "deepseek-v4-pro", Grade: "highest", ContextWindow: 1048576, MaxTokens: 65536},
		},
	},
	{
		ID: "openrouter", Label: "OpenRouter", API: "openai-completions",
		BaseURL: "https://openrouter.ai/api/v1", CredentialRefHint: "OPENROUTER_API_KEY",
		DocsURL: "https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties",
		Notes:   []string{"兼容传输；模型目录与价格随路由变化，需刷新并从来源标注，不覆盖历史费用。"},
		Models: []ProviderTemplateModel{
			{ID: "openrouter/auto", Grade: "high", ContextWindow: 128000, MaxTokens: 8192},
		},
	},
	{
		ID: "custom", Label: "自定义兼容平台 / 本地服务", API: "openai-completions",
		BaseURL: "", CredentialRefHint: "GRAPH_LOCAL_KEY", DocsURL: "",
		Notes:  []string{"高级入口：端点、模型与可选 key；不宣称支持任意协议。无 key 的本地服务不要填伪密钥。"},
		Models: []ProviderTemplateModel{},
	},
}

func init() {
	// Attach only archived, source-dated prices. Models without a verified entry
	// keep cost/pricing absent so the wizard shows "价格未知" instead of zero.
	for i := range PROVIDER_TEMPLATES {
		for j := range PROVIDER_TEMPLATES[i].Models {
			snapshot := SnapshotFor(PROVIDER_TEMPLATES[i].ID, PROVIDER_TEMPLATES[i].Models[j].ID)
			if snapshot == nil {
				continue
			}
			cost := snapshot.Cost
			PROVIDER_TEMPLATES[i].Models[j].Cost = &cost
			pricing := SnapshotPricing(*snapshot)
			PROVIDER_TEMPLATES[i].Models[j].Pricing = &pricing
		}
	}
}

func ProviderTemplate(id string) *ProviderTemplateRecord {
	for i := range PROVIDER_TEMPLATES {
		if PROVIDER_TEMPLATES[i].ID == id {
			return &PROVIDER_TEMPLATES[i]
		}
	}
	return nil
}

// TemplateModelEntryRecord is the config entry for one template model; unknown prices stay absent.
// Field order matches the TypeScript object literal.
type TemplateModelEntryRecord struct {
	ID            string        `json:"id"`
	Provider      string        `json:"provider"`
	Grade         string        `json:"grade"`
	API           string        `json:"api"`
	BaseURL       string        `json:"baseUrl"`
	ContextWindow int           `json:"contextWindow"`
	MaxTokens     int           `json:"maxTokens"`
	Input         []string      `json:"input,omitempty"`
	CredentialID  string        `json:"credentialId"`
	Cost          *ModelCost    `json:"cost,omitempty"`
	Pricing       *ModelPricing `json:"pricing,omitempty"`
}

func TemplateModelEntry(template ProviderTemplateRecord, model ProviderTemplateModel, credentialID string) TemplateModelEntryRecord {
	return TemplateModelEntryRecord{
		ID: model.ID, Provider: template.ID, Grade: model.Grade, API: template.API,
		BaseURL: template.BaseURL, ContextWindow: model.ContextWindow, MaxTokens: model.MaxTokens,
		Input: model.Input, CredentialID: credentialID, Cost: model.Cost, Pricing: model.Pricing,
	}
}
