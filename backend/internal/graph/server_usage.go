package graph

import (
	"regexp"

	"bytes"
)

type UsageProviderId string

const (
	UsageProviderOpenCodeGo  UsageProviderId = "opencode-go"
	UsageProviderCommandGoat UsageProviderId = "command-goat"
	UsageProviderDeepSeek    UsageProviderId = "deepseek"
	UsageProviderGrok        UsageProviderId = "grok"
	UsageProviderChatGPT     UsageProviderId = "chatgpt"
)

var usageProviderOrder = []UsageProviderId{
	UsageProviderOpenCodeGo, UsageProviderCommandGoat, UsageProviderDeepSeek,
	UsageProviderChatGPT, UsageProviderGrok,
}

type UsageStatus string

const (
	UsageStatusOK           UsageStatus = "ok"
	UsageStatusWarning      UsageStatus = "warning"
	UsageStatusLimited      UsageStatus = "limited"
	UsageStatusUnconfigured UsageStatus = "unconfigured"
	UsageStatusError        UsageStatus = "error"
)

type SubscriptionModelApi string

const (
	SubscriptionModelApiOpenAICompletions SubscriptionModelApi = "openai-completions"
	SubscriptionModelApiAnthropicMessages SubscriptionModelApi = "anthropic-messages"
	SubscriptionModelApiResponses         SubscriptionModelApi = "openai-responses"
)

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

type UsageBalance struct {
	Remaining *float64 `json:"remaining,omitempty"`
	Used      *float64 `json:"used,omitempty"`
	Total     *float64 `json:"total,omitempty"`
	Currency  *string  `json:"currency,omitempty"`
	Unit      *string  `json:"unit,omitempty"`
}

type UsageCredential struct {
	ID          string  `json:"id"`
	SecretRef   string  `json:"secretRef"`
	Source      string  `json:"source"`
	Configured  bool    `json:"configured"`
	DisplayName *string `json:"displayName,omitempty"`
}

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

type UsageAccount struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type UsageDetailEntry struct {
	Key   string
	Value any
}

type UsageDetails []UsageDetailEntry

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

type ModelPrice struct {
	ModelID                     string  `json:"modelId"`
	DisplayName                 string  `json:"displayName"`
	InputCostPerMillion         float64 `json:"inputCostPerMillion"`
	OutputCostPerMillion        float64 `json:"outputCostPerMillion"`
	CacheReadCostPerMillion     float64 `json:"cacheReadCostPerMillion"`
	CacheCreationCostPerMillion float64 `json:"cacheCreationCostPerMillion"`
}

type ModelPricingSnapshot struct {
	Source    string       `json:"source"`
	UpdatedAt *int64       `json:"updatedAt"`
	Models    []ModelPrice `json:"models"`
}

type UsageSummary struct {
	Configured   int `json:"configured"`
	Connected    int `json:"connected"`
	Warnings     int `json:"warnings"`
	Limited      int `json:"limited"`
	Unconfigured int `json:"unconfigured"`
}

type UsageSnapshot struct {
	GeneratedAt int64                `json:"generatedAt"`
	Plans       []UsagePlan          `json:"plans"`
	Pricing     ModelPricingSnapshot `json:"pricing"`
	Summary     UsageSummary         `json:"summary"`
}

type UsageService interface {
	Get(force bool) (UsageSnapshot, error)
	Pricing() (ModelPricingSnapshot, error)
	Credentials() (map[string]string, error)
	SecretValues() map[string]string
}

type UsageServiceOptions struct {
	Env        map[string]string
	Home       string
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

var usageSubscriptionSecretRefs = map[UsageProviderId]string{
	UsageProviderOpenCodeGo:  "GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY",
	UsageProviderCommandGoat: "GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY",
	UsageProviderDeepSeek:    "GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY",
	UsageProviderGrok:        "GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN",
	UsageProviderChatGPT:     "GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN",
}

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

type usagePiModel struct {
	ID            string
	Name          string
	API           string
	BaseURL       string
	Reasoning     bool
	ContextWindow int
	MaxTokens     int
}

func usageOpenCodeModels() map[string]usagePiModel {
	return usageKernelModels("opencode-go")
}
