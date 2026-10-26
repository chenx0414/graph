package graph

import (
	"regexp"

	"bytes"
)

// UsageProviderId is one subscription platform Graph can report usage for.
type UsageProviderId string

const (
	// UsageProviderOpenCodeGo is the OpenCode Go subscription.
	UsageProviderOpenCodeGo UsageProviderId = "opencode-go"
	// UsageProviderCommandGoat is the Command Goat subscription.
	UsageProviderCommandGoat UsageProviderId = "command-goat"
	// UsageProviderDeepSeek is the DeepSeek API balance.
	UsageProviderDeepSeek UsageProviderId = "deepseek"
	// UsageProviderGrok is the xAI SuperGrok subscription.
	UsageProviderGrok UsageProviderId = "grok"
	// UsageProviderChatGPT is the ChatGPT Codex subscription.
	UsageProviderChatGPT UsageProviderId = "chatgpt"
)

// usageProviderOrder is the platform order the snapshot and the credential
// map follow.
var usageProviderOrder = []UsageProviderId{
	UsageProviderOpenCodeGo, UsageProviderCommandGoat, UsageProviderDeepSeek,
	UsageProviderChatGPT, UsageProviderGrok,
}

// UsageStatus is the state one plan reports.
type UsageStatus string

const (
	UsageStatusOK           UsageStatus = "ok"
	UsageStatusWarning      UsageStatus = "warning"
	UsageStatusLimited      UsageStatus = "limited"
	UsageStatusUnconfigured UsageStatus = "unconfigured"
	UsageStatusError        UsageStatus = "error"
)

// SubscriptionModelApi is the transport a subscription model speaks.
type SubscriptionModelApi string

const (
	SubscriptionModelApiOpenAICompletions SubscriptionModelApi = "openai-completions"
	SubscriptionModelApiAnthropicMessages SubscriptionModelApi = "anthropic-messages"
	SubscriptionModelApiResponses         SubscriptionModelApi = "responses"
)

// UsageWindow is one quota window of a plan.
type UsageWindow struct {
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	UsedPercent      float64  `json:"usedPercent"`
	RemainingPercent float64  `json:"remainingPercent"`
	ResetAt          *int64   `json:"resetAt"`
	Used             *float64 `json:"used,omitempty"`
	Limit            *float64 `json:"limit,omitempty"`
	Unit             *string  `json:"unit,omitempty"`
}

// UsageBalance is the money left on a plan.
type UsageBalance struct {
	Remaining *float64 `json:"remaining,omitempty"`
	Used      *float64 `json:"used,omitempty"`
	Total     *float64 `json:"total,omitempty"`
	Currency  *string  `json:"currency,omitempty"`
	Unit      *string  `json:"unit,omitempty"`
}

// UsageCredential is one credential a plan reports.
type UsageCredential struct {
	ID          string  `json:"id"`
	SecretRef   string  `json:"secretRef"`
	Source      string  `json:"source"`
	Configured  bool    `json:"configured"`
	DisplayName *string `json:"displayName,omitempty"`
}

// SubscriptionModel is one model a subscription plan exposes.
type SubscriptionModel struct {
	ID                          string               `json:"id"`
	Name                        string               `json:"name"`
	API                         SubscriptionModelApi `json:"api"`
	BaseURL                     string               `json:"baseUrl"`
	ContextWindow               int                  `json:"contextWindow"`
	MaxTokens                   int                  `json:"maxTokens"`
	Reasoning                   bool                 `json:"reasoning"`
	Supported                   bool                 `json:"supported"`
	InputCostPerMillion         *float64             `json:"inputCostPerMillion,omitempty"`
	OutputCostPerMillion        *float64             `json:"outputCostPerMillion,omitempty"`
	CacheReadCostPerMillion     *float64             `json:"cacheReadCostPerMillion,omitempty"`
	CacheCreationCostPerMillion *float64             `json:"cacheCreationCostPerMillion,omitempty"`
	Headers                     map[string]string    `json:"headers,omitempty"`
}

// UsageAccount is the extra account a plan belongs to.
type UsageAccount struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// UsageDetailEntry is one key/value pair of a plan's detail table.
type UsageDetailEntry struct {
	Key   string
	Value any
}

// UsageDetails is an ordered detail table. TypeScript kept insertion order;
// Go maps do not, so the pairs keep their order in a slice.
type UsageDetails []UsageDetailEntry

// MarshalJSON writes the pairs in insertion order.
func (details UsageDetails) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, entry := range details {
		if index > 0 {
			buffer.WriteByte(',')
		}
		key, err := marshalUsageJSON(entry.Key)
		if err != nil {
			return nil, err
		}
		buffer.Write(key)
		buffer.WriteByte(':')
		value, err := marshalUsageJSON(entry.Value)
		if err != nil {
			return nil, err
		}
		buffer.Write(value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// UsagePlan is one subscription plan in the usage snapshot.
type UsagePlan struct {
	ID               string              `json:"id"`
	Platform         UsageProviderId     `json:"platform"`
	Account          *UsageAccount       `json:"account"`
	Name             string              `json:"name"`
	Subtitle         string              `json:"subtitle"`
	Configured       bool                `json:"configured"`
	Status           UsageStatus         `json:"status"`
	Plan             *string             `json:"plan"`
	CredentialSource *string             `json:"credentialSource"`
	Credential       *UsageCredential    `json:"credential"`
	Models           []SubscriptionModel `json:"models"`
	Windows          []UsageWindow       `json:"windows"`
	Balance          *UsageBalance       `json:"balance"`
	Details          UsageDetails        `json:"details"`
	Error            *string             `json:"error"`
	UpdatedAt        int64               `json:"updatedAt"`
}

// ModelPrice is one archived model price.
type ModelPrice struct {
	ModelID                     string  `json:"modelId"`
	DisplayName                 string  `json:"displayName"`
	InputCostPerMillion         float64 `json:"inputCostPerMillion"`
	OutputCostPerMillion        float64 `json:"outputCostPerMillion"`
	CacheReadCostPerMillion     float64 `json:"cacheReadCostPerMillion"`
	CacheCreationCostPerMillion float64 `json:"cacheCreationCostPerMillion"`
}

// ModelPricingSnapshot is the local price table.
type ModelPricingSnapshot struct {
	Source    string       `json:"source"`
	UpdatedAt *int64       `json:"updatedAt"`
	Models    []ModelPrice `json:"models"`
}

// UsageSummary counts the plans by state.
type UsageSummary struct {
	Configured   int `json:"configured"`
	Connected    int `json:"connected"`
	Warnings     int `json:"warnings"`
	Limited      int `json:"limited"`
	Unconfigured int `json:"unconfigured"`
}

// UsageSnapshot is the whole usage page payload.
type UsageSnapshot struct {
	GeneratedAt int64                `json:"generatedAt"`
	Plans       []UsagePlan          `json:"plans"`
	Pricing     ModelPricingSnapshot `json:"pricing"`
	Summary     UsageSummary         `json:"summary"`
}

// UsageService is the subscription-usage surface the console reads.
type UsageService interface {
	// Get returns the usage snapshot. A forced read always refetches.
	Get(force bool) (UsageSnapshot, error)
	// Pricing is the lightweight local price snapshot, without querying
	// subscription providers.
	Pricing() (ModelPricingSnapshot, error)
	// Credentials are the detected subscription providers mapped to the
	// credential ref Graph should use.
	Credentials() (map[string]string, error)
	// SecretValues are the secret values imported from local subscription
	// configuration or login files. These stay inside the daemon and are never
	// included in an HTTP response.
	SecretValues() map[string]string
}

// UsageServiceOptions configures the usage service.
type UsageServiceOptions struct {
	// Env is the environment the service reads credentials from. A nil map
	// falls back to the process environment.
	Env map[string]string
	// Home is the directory the local login files live under.
	Home string
	// LoadConfig reads the current configuration and the merged environment.
	LoadConfig func() (GraphConfig, map[string]string)
}

const (
	usageCacheTTLMs       = 60_000
	usageRequestTimeoutMs = 15_000
)

const (
	usageOpenCodeURL      = "https://opencode.ai/zen/go/v1/usage"
	usageCommandCodeBase  = "https://api.commandcode.ai"
	usageDeepSeekURL      = "https://api.deepseek.com/user/balance"
	usageChatGPTURL       = "https://chatgpt.com/backend-api/wham/usage"
	usageGrokBillingURL   = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
	usageModelsDevURL     = "https://models.dev/api.json"
	usageChatGPTModelsURL = "https://chatgpt.com/backend-api/codex/models"
)

// usagePlanBlueprint is the display name of one platform.
type usagePlanBlueprint struct {
	Name     string
	Subtitle string
}

var usagePlanBlueprints = map[UsageProviderId]usagePlanBlueprint{
	UsageProviderOpenCodeGo:  {Name: "OpenCode Go", Subtitle: "openCode.ai · 5 小时滚动额度"},
	UsageProviderCommandGoat: {Name: "Command Goat", Subtitle: "CommandCode · 月度订阅额度"},
	UsageProviderDeepSeek:    {Name: "DeepSeek", Subtitle: "DeepSeek 官方 API · 账户余额"},
	UsageProviderGrok:        {Name: "Grok", Subtitle: "xAI SuperGrok · 周期额度"},
	UsageProviderChatGPT:     {Name: "ChatGPT", Subtitle: "ChatGPT Codex · 官方订阅额度"},
}

// usageSubscriptionSecretRefs names the environment variable each platform
// subscription reads.
var usageSubscriptionSecretRefs = map[UsageProviderId]string{
	UsageProviderOpenCodeGo:  "GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY",
	UsageProviderCommandGoat: "GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY",
	UsageProviderDeepSeek:    "GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY",
	UsageProviderGrok:        "GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN",
	UsageProviderChatGPT:     "GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN",
}

// usageDefaultBaseURLs are the endpoints each platform falls back to.
var usageDefaultBaseURLs = map[UsageProviderId]string{
	UsageProviderOpenCodeGo:  "https://opencode.ai/zen/go/v1",
	UsageProviderCommandGoat: "https://api.commandcode.ai/provider/v1",
	UsageProviderDeepSeek:    "https://api.deepseek.com",
	UsageProviderGrok:        "https://api.x.ai/v1",
	UsageProviderChatGPT:     "https://chatgpt.com/backend-api/codex",
}

var usageCommandPlanQuota = map[string]float64{
	"individual-go":    10,
	"individual-goat":  70,
	"individual-pro":   80,
	"individual-max":   150,
	"individual-ultra": 300,
}

var usageCommandPlanName = map[string]string{
	"individual-go":    "Go",
	"individual-goat":  "GOAT",
	"individual-pro":   "Pro",
	"individual-max":   "Max",
	"individual-ultra": "Ultra",
}

var usageNonReasoningPattern = regexp.MustCompile(`non-reasoning|flash-lite`)

// usagePiModel is one entry of the bundled OpenCode Go model catalog.
type usagePiModel struct {
	ID            string
	Name          string
	API           string
	BaseURL       string
	Reasoning     bool
	ContextWindow int
	MaxTokens     int
}

// usageOpenCodeModels is the OpenCode Go model catalog the Pi package ships.
// The package is a Node module; the table is embedded here because the usage
// page reports the models a subscription exposes.
var usageOpenCodeModels = map[string]usagePiModel{
	"minimax-m3":                   {ID: "minimax-m3", Name: "MiniMax-M3", API: "anthropic-messages", BaseURL: "https://opencode.ai/zen/go", Reasoning: true, ContextWindow: 1000000, MaxTokens: 131072},
	"qwen3.8-flash":                {ID: "qwen3.8-flash", Name: "Qwen3.8 Flash", API: "anthropic-messages", BaseURL: "https://opencode.ai/zen/go", Reasoning: true, ContextWindow: 1000000, MaxTokens: 131072},
	"deepseek-v4-flash":            {ID: "deepseek-v4-flash", Name: "DeepSeek V4 Flash", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 384000},
	"deepseek-v4-flash-vision-exp": {ID: "deepseek-v4-flash-vision-exp", Name: "DeepSeek V4 Flash Vision Exp", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 384000},
	"deepseek-v4-pro":              {ID: "deepseek-v4-pro", Name: "DeepSeek V4 Pro (New)", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 384000},
	"deepseek-v4.1-flash":          {ID: "deepseek-v4.1-flash", Name: "DeepSeek V4.1 Flash", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 384000},
	"glm-5.1":                      {ID: "glm-5.1", Name: "GLM-5.1", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 202752, MaxTokens: 32768},
	"glm-5.2":                      {ID: "glm-5.2", Name: "GLM-5.2", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 131072},
	"glm-5.3":                      {ID: "glm-5.3", Name: "GLM-5.3", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 131072},
	"glm-5.3-flash":                {ID: "glm-5.3-flash", Name: "GLM-5.3-Flash", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 131072},
	"hy3":                          {ID: "hy3", Name: "Hy3", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 256000, MaxTokens: 128000},
	"hy4-preview":                  {ID: "hy4-preview", Name: "Hy4 preview", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1024000, MaxTokens: 64000},
	"kimi-k2.6":                    {ID: "kimi-k2.6", Name: "Kimi K2.6", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 262144, MaxTokens: 65536},
	"kimi-k2.7-code":               {ID: "kimi-k2.7-code", Name: "Kimi K2.7 Code", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 262144, MaxTokens: 262144},
	"kimi-k3":                      {ID: "kimi-k3", Name: "Kimi K3", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1048576, MaxTokens: 131072},
	"longcat-2.0":                  {ID: "longcat-2.0", Name: "LongCat-2.0", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 131072},
	"mimo-v2.5":                    {ID: "mimo-v2.5", Name: "MiMo V2.5", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 128000},
	"mimo-v2.5-pro":                {ID: "mimo-v2.5-pro", Name: "MiMo V2.5 Pro", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1048576, MaxTokens: 128000},
	"minimax-m2.7":                 {ID: "minimax-m2.7", Name: "MiniMax-M2.7", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 204800, MaxTokens: 131072},
	"qwen3.6-plus":                 {ID: "qwen3.6-plus", Name: "Qwen3.6 Plus", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 65536},
	"qwen3.7-max":                  {ID: "qwen3.7-max", Name: "Qwen3.7 Max", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 65536},
	"qwen3.7-plus":                 {ID: "qwen3.7-plus", Name: "Qwen3.7 Plus", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 65536},
	"qwen3.8-max":                  {ID: "qwen3.8-max", Name: "Qwen3.8 Max", API: "openai-completions", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1000000, MaxTokens: 131072},
	"gpt-5.6-luna":                 {ID: "gpt-5.6-luna", Name: "GPT-5.6 Luna", API: "openai-responses", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1050000, MaxTokens: 128000},
	"grok-4.6":                     {ID: "grok-4.6", Name: "Grok 4.6", API: "openai-responses", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 500000, MaxTokens: 500000},
	"muse-spark-1.2-contributor":   {ID: "muse-spark-1.2-contributor", Name: "Muse Spark 1.2 Contributor", API: "openai-responses", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1048576, MaxTokens: 131072},
	"muse-spark-1.3-contributor":   {ID: "muse-spark-1.3-contributor", Name: "Muse Spark 1.3 Contributor", API: "openai-responses", BaseURL: "https://opencode.ai/zen/go/v1", Reasoning: true, ContextWindow: 1048576, MaxTokens: 131072},
}
