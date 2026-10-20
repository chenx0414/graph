package graph

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
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

// usageRecord returns the value as a plain object, or nil.
func usageRecord(value any) map[string]any {
	if value == nil {
		return nil
	}
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return record
}

// usageArray returns the value as a list, or an empty list.
func usageArray(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return []any{}
}

// usageText returns a trimmed non-empty string, or nil.
func usageText(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// number reads a finite number from a JSON value.
func number(value any) *float64 {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil
		}
		return &typed
	case float32:
		converted := float64(typed)
		return &converted
	case int:
		converted := float64(typed)
		return &converted
	case int64:
		converted := float64(typed)
		return &converted
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil
		}
		return &parsed
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil
		}
		return &parsed
	}
	return nil
}

// usageNumberValue reads a number for an ordered detail table: a missing
// value stays null.
func usageNumberValue(value any) any {
	parsed := number(value)
	if parsed == nil {
		return nil
	}
	return *parsed
}

// boolean reads a boolean from a JSON value.
func boolean(value any) *bool {
	switch typed := value.(type) {
	case bool:
		return &typed
	case string:
		if typed == "true" {
			truth := true
			return &truth
		}
		if typed == "false" {
			falsy := false
			return &falsy
		}
	}
	return nil
}

// clampPercent keeps a percentage inside 0..100.
func clampPercent(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

// parseDate reads an epoch (seconds or milliseconds) or an ISO timestamp.
func parseDate(value any) *int64 {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil
		}
		return parseEpoch(typed)
	case int64:
		return parseEpoch(float64(typed))
	case int:
		return parseEpoch(float64(typed))
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return nil
		}
		return parseEpoch(parsed)
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02T15:04:05", "2006-01-02"} {
			if parsed, err := time.Parse(layout, trimmed); err == nil {
				millis := parsed.UnixMilli()
				return &millis
			}
		}
	}
	return nil
}

// parseEpoch turns a numeric epoch into milliseconds.
func parseEpoch(value float64) *int64 {
	if value <= 0 {
		return nil
	}
	if value < 10_000_000_000 {
		millis := int64(value * 1000)
		return &millis
	}
	millis := int64(value)
	return &millis
}

// usageBasePlan is the unconfigured plan of one platform.
func usageBasePlan(id UsageProviderId, configured bool, status UsageStatus) UsagePlan {
	blueprint := usagePlanBlueprints[id]
	return UsagePlan{
		ID: string(id), Platform: id, Account: nil,
		Name: blueprint.Name, Subtitle: blueprint.Subtitle,
		Configured: configured, Status: status,
		Plan: nil, CredentialSource: nil, Credential: nil,
		Models: []SubscriptionModel{}, Windows: []UsageWindow{},
		Balance: nil, Details: UsageDetails{}, Error: nil,
		UpdatedAt: NowMillis(),
	}
}

// usageStatusFor reads the plan status from its quota windows.
func usageStatusFor(windows []UsageWindow) UsageStatus {
	maxUsed := 0.0
	for _, window := range windows {
		if window.UsedPercent > maxUsed {
			maxUsed = window.UsedPercent
		}
	}
	if maxUsed >= 100 {
		return UsageStatusLimited
	}
	if maxUsed >= 80 {
		return UsageStatusWarning
	}
	return UsageStatusOK
}

// usageErrorMessage is the message of a failed plan.
func usageErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// marshalUsageJSON encodes a value the way JSON.stringify does: without HTML
// escaping and without a trailing newline.
func marshalUsageJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

// usageCredential is one resolved subscription credential.
type usageCredential struct {
	ID          string
	SecretRef   string
	Source      string
	Configured  bool
	DisplayName *string
	Value       string
	BaseURL     string
	AccountID   *string
}

// usageSelectedCredential reads the first environment variable that holds a
// credential for the platform.
func usageSelectedCredential(env map[string]string, provider UsageProviderId, names []string, baseURL string) *usageCredential {
	for _, name := range names {
		value := strings.TrimSpace(env[name])
		if value == "" {
			continue
		}
		return &usageCredential{
			ID: string(provider), SecretRef: usageSubscriptionSecretRefs[provider], Configured: true,
			Value: value, Source: "环境变量 " + name, BaseURL: baseURL,
		}
	}
	return nil
}

// usageConfigCredential reads the credential a configured model uses.
func usageConfigCredential(config *GraphConfig, env map[string]string, provider UsageProviderId, match func(ConfiguredModel) bool) *usageCredential {
	if config == nil || config.Models == nil {
		return nil
	}
	for _, entry := range config.Models.Entries {
		if !match(entry) {
			continue
		}
		credential, ok := config.Credentials[entry.CredentialID]
		if !ok {
			continue
		}
		value := strings.TrimSpace(env[credential.SecretRef])
		if value == "" {
			continue
		}
		return &usageCredential{
			ID: entry.CredentialID, SecretRef: credential.SecretRef, Configured: true,
			Value: value, Source: "Graph 模型 · " + entry.Provider, BaseURL: entry.BaseUrl,
		}
	}
	return nil
}

// usagePlatformAccountCredentials are every credential that declares itself an
// account of the platform. The platform's own credential (from the
// environment, the vendor config or the model that uses it) stays the primary
// one; these are the additional accounts an operator added, and each is
// queried with its own secret.
func usagePlatformAccountCredentials(config *GraphConfig, env map[string]string, platform UsageProviderId) []usageCredential {
	accounts := []usageCredential{}
	if config == nil {
		return accounts
	}
	ids := make([]string, 0, len(config.Credentials))
	for id := range config.Credentials {
		ids = append(ids, id)
	}
	// The TypeScript object kept the file order; the Go map does not, so the
	// accounts are reported in a stable order instead.
	sort.Strings(ids)
	for _, id := range ids {
		credential := config.Credentials[id]
		if credential.Platform != string(platform) {
			continue
		}
		value := strings.TrimSpace(env[credential.SecretRef])
		displayName := strings.TrimSpace(credential.DisplayName)
		if displayName == "" {
			displayName = id
		}
		// An account the operator configured must never vanish from 用量 just
		// because its key is not resolvable in this process; it shows up as
		// waiting for a key.
		name := displayName
		accounts = append(accounts, usageCredential{
			ID: id, SecretRef: credential.SecretRef, Configured: value != "", Value: value,
			Source: "Graph 账户 · " + displayName, DisplayName: &name,
		})
	}
	return accounts
}

// usageLiteralCredential reads a credential written as a literal value.
func usageLiteralCredential(value any, provider UsageProviderId, source string, baseURL string) *usageCredential {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return nil
	}
	if strings.Contains(normalized, "${") || strings.HasPrefix(normalized, "env:") || strings.Contains(normalized, "{env:") {
		return nil
	}
	return &usageCredential{
		ID: string(provider), SecretRef: usageSubscriptionSecretRefs[provider], Configured: true,
		Value: normalized, Source: source, BaseURL: baseURL,
	}
}

// usageOpenCodeProviderCredential reads a credential from the local OpenCode
// configuration.
func usageOpenCodeProviderCredential(config any, providerID UsageProviderId, ids []string, baseHint string) *usageCredential {
	providers := usageRecord(usageRecord(config)["provider"])
	if providers == nil {
		return nil
	}
	names := make([]string, 0, len(providers))
	for name := range providers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		provider := usageRecord(providers[name])
		options := usageRecord(provider["options"])
		baseURL := ""
		if value := usageText(options["baseURL"]); value != nil {
			baseURL = *value
		}
		if !usageContainsFold(ids, name) && !strings.Contains(strings.ToLower(baseURL), baseHint) {
			continue
		}
		fallback := baseURL
		if fallback == "" {
			fallback = usageDefaultBaseURLs[providerID]
		}
		credential := usageLiteralCredential(options["apiKey"], providerID, "OpenCode 配置 · "+name, fallback)
		if credential != nil {
			return credential
		}
	}
	return nil
}

// usageContainsFold reports whether the list holds the name, case-insensitively.
func usageContainsFold(names []string, name string) bool {
	lowered := strings.ToLower(name)
	for _, candidate := range names {
		if strings.ToLower(candidate) == lowered {
			return true
		}
	}
	return false
}

// usageFirstCredential returns the first credential that resolved.
func usageFirstCredential(values ...*usageCredential) *usageCredential {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// usageCredentialInfo is the credential view a plan reports. The secret value
// never leaves the daemon.
func usageCredentialInfo(credential *usageCredential) UsageCredential {
	return UsageCredential{
		ID: credential.ID, SecretRef: credential.SecretRef, Source: credential.Source,
		Configured: credential.Configured, DisplayName: credential.DisplayName,
	}
}

// usageFetch performs one bounded HTTP request and reads the whole body.
func usageFetch(method, url string, headers map[string]string, body []byte, timeoutMs int) (int, http.Header, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return 0, nil, nil, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := HTTPClient.Do(request)
	if err != nil {
		return 0, nil, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return response.StatusCode, response.Header, nil, err
	}
	return response.StatusCode, response.Header, raw, nil
}

// usageResponseJSON reads a JSON object reply.
func usageResponseJSON(status int, raw []byte, label string) (map[string]any, error) {
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("%s HTTP %d", label, status)
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("%s 响应解析失败", label)
	}
	body := usageRecord(parsed)
	if body == nil {
		return nil, errors.New("响应不是 JSON 对象")
	}
	return body, nil
}

// usageWindowDetails are the optional numbers a quota window carries.
type usageWindowDetails struct {
	Used  *float64
	Limit *float64
	Unit  *string
}

// usagePercentWindow builds one quota window.
func usagePercentWindow(id string, label string, used float64, resetAt *int64, details usageWindowDetails) UsageWindow {
	normalized := clampPercent(used)
	return UsageWindow{
		ID: id, Label: label, UsedPercent: normalized,
		RemainingPercent: clampPercent(100 - normalized), ResetAt: resetAt,
		Used: details.Used, Limit: details.Limit, Unit: details.Unit,
	}
}

// usageOpenCodeWindows reads the quota windows of an OpenCode Go reply.
func usageOpenCodeWindows(body map[string]any, now int64) []UsageWindow {
	usage := usageRecord(body["usage"])
	if usage == nil {
		return []UsageWindow{}
	}
	windows := []UsageWindow{}
	entries := []struct {
		id    string
		label string
	}{{"rolling", "5 小时"}, {"weekly", "本周"}, {"monthly", "本月"}}
	for _, entry := range entries {
		raw := usageRecord(usage[entry.id])
		if raw == nil {
			continue
		}
		percent := number(raw["percent"])
		if percent == nil {
			continue
		}
		var resetAt *int64
		if *percent > 0 {
			resetAt = parseDate(raw["resetsAt"])
		}
		windows = append(windows, usagePercentWindow(entry.id, entry.label, *percent, resetAt, usageWindowDetails{}))
	}
	// The legacy HTML/DOM endpoint used rollingUsage, weeklyUsage and
	// monthlyUsage. Keep this fallback so a dashboard format rollback does not
	// make the card empty.
	if len(windows) == 0 {
		legacy := []struct {
			key   string
			id    string
			label string
		}{{"rollingUsage", "rolling", "5 小时"}, {"weeklyUsage", "weekly", "本周"}, {"monthlyUsage", "monthly", "本月"}}
		for _, entry := range legacy {
			raw := usageRecord(usage[entry.key])
			if raw == nil {
				continue
			}
			percent := number(raw["usagePercent"])
			if percent == nil {
				continue
			}
			resetSeconds := number(raw["resetInSec"])
			var resetAt *int64
			if resetSeconds != nil {
				millis := now + int64(*resetSeconds*1000)
				resetAt = &millis
			}
			windows = append(windows, usagePercentWindow(entry.id, entry.label, *percent, resetAt, usageWindowDetails{}))
		}
	}
	return windows
}

// usageOpenCodeCredential resolves the OpenCode Go credential.
func usageOpenCodeCredential(config *GraphConfig, env map[string]string, openCodeConfig any) *usageCredential {
	return usageFirstCredential(
		usageSelectedCredential(env, UsageProviderOpenCodeGo, []string{"OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"}, usageDefaultBaseURLs[UsageProviderOpenCodeGo]),
		usageConfigCredential(config, env, UsageProviderOpenCodeGo, func(entry ConfiguredModel) bool {
			return strings.Contains(entry.BaseUrl, "opencode.ai/zen/go") || strings.Contains(strings.ToLower(entry.Provider), "opencode-go")
		}),
		usageOpenCodeProviderCredential(openCodeConfig, UsageProviderOpenCodeGo, []string{"opencode-go"}, "opencode.ai/zen/go"),
	)
}

// usageFetchOpenCode reads the OpenCode Go quota.
func usageFetchOpenCode(credential *usageCredential, now int64, prices []ModelPrice, openCodeConfig any) (UsagePlan, error) {
	status, _, raw, err := usageFetch("GET", usageOpenCodeURL, map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
	}, nil, usageRequestTimeoutMs)
	if err != nil {
		return UsagePlan{}, err
	}
	if status == 403 {
		return UsagePlan{}, errors.New("API Key 有效，但当前账号没有 OpenCode Go 订阅")
	}
	body, err := usageResponseJSON(status, raw, "OpenCode Go 用量")
	if err != nil {
		return UsagePlan{}, err
	}
	windows := usageOpenCodeWindows(body, now)
	if len(windows) == 0 {
		return UsagePlan{}, errors.New("用量响应中没有可识别的配额窗口")
	}
	models := usageDiscoverOpenCodeModels(credential, prices, openCodeConfig)
	plan := usageBasePlan(UsageProviderOpenCodeGo, true, usageStatusFor(windows))
	plan.Plan = providerStringPointer("Go")
	plan.CredentialSource = providerStringPointer(credential.Source)
	info := usageCredentialInfo(credential)
	plan.Credential = &info
	plan.Windows = windows
	plan.Models = models
	return plan, nil
}

// usageCommandWindow reads one CommandCode quota window.
func usageCommandWindow(id string, label string, raw map[string]any) *UsageWindow {
	if raw == nil {
		return nil
	}
	used := number(raw["used"])
	limit := number(raw["cap"])
	if used == nil || limit == nil || *limit <= 0 {
		return nil
	}
	reset := number(raw["resetAt"])
	var resetAt *int64
	if reset != nil {
		value := int64(*reset)
		resetAt = &value
	}
	unit := "USD"
	window := usagePercentWindow(id, label, (*used / *limit)*100, resetAt, usageWindowDetails{
		Used: used, Limit: limit, Unit: &unit,
	})
	return &window
}

// usageCommandGoatCredential resolves the Command Goat credential.
func usageCommandGoatCredential(config *GraphConfig, env map[string]string, openCodeConfig any) *usageCredential {
	return usageFirstCredential(
		usageSelectedCredential(env, UsageProviderCommandGoat, []string{"COMMANDCODE_API_KEY", "COMMAND_GOAT_API_KEY", "COMMANDCODE_GO_API_KEY"}, usageDefaultBaseURLs[UsageProviderCommandGoat]),
		usageConfigCredential(config, env, UsageProviderCommandGoat, func(entry ConfiguredModel) bool {
			return strings.Contains(entry.BaseUrl, "api.commandcode.ai") || strings.Contains(strings.ToLower(entry.Provider), "command")
		}),
		usageOpenCodeProviderCredential(openCodeConfig, UsageProviderCommandGoat, []string{"command-goat", "commandcode"}, "api.commandcode.ai"),
	)
}

// usageFetchCommandGoat reads the Command Goat quota and balance.
func usageFetchCommandGoat(credential *usageCredential, now int64, prices []ModelPrice, openCodeConfig any) (UsagePlan, error) {
	headers := map[string]string{"authorization": "Bearer " + credential.Value, "accept": "application/json"}
	creditsURL := usageCommandCodeBase + "/alpha/billing/credits"
	subscriptionURL := usageCommandCodeBase + "/alpha/billing/subscriptions"
	// The TypeScript read both replies concurrently; the two round-trips are
	// independent, so they overlap here too.
	type fetchResult struct {
		status int
		raw    []byte
		err    error
	}
	creditsChannel := make(chan fetchResult, 1)
	subscriptionChannel := make(chan fetchResult, 1)
	go func() {
		status, _, raw, err := usageFetch("GET", creditsURL, headers, nil, usageRequestTimeoutMs)
		creditsChannel <- fetchResult{status: status, raw: raw, err: err}
	}()
	go func() {
		status, _, raw, err := usageFetch("GET", subscriptionURL, headers, nil, usageRequestTimeoutMs)
		subscriptionChannel <- fetchResult{status: status, raw: raw, err: err}
	}()
	creditsResult := <-creditsChannel
	subscriptionResult := <-subscriptionChannel
	if creditsResult.err != nil {
		return UsagePlan{}, creditsResult.err
	}
	creditsBody, err := usageResponseJSON(creditsResult.status, creditsResult.raw, "Command Goat 余额")
	if err != nil {
		return UsagePlan{}, err
	}
	credits := usageRecord(creditsBody["credits"])
	if credits == nil {
		return UsagePlan{}, errors.New("余额响应缺少 credits")
	}
	var subscriptionBody map[string]any
	if subscriptionResult.err == nil && subscriptionResult.status >= 200 && subscriptionResult.status < 300 {
		parsed, parseErr := usageResponseJSON(subscriptionResult.status, subscriptionResult.raw, "Command Goat 订阅")
		if parseErr == nil {
			subscriptionBody = parsed
		}
	}
	subscription := usageRecord(subscriptionBody["data"])
	planID := usageText(subscription["planId"])
	monthlyRemaining := 0.0
	if value := number(credits["monthlyCredits"]); value != nil {
		monthlyRemaining = *value
	}
	var monthlyTotal *float64
	if planID != nil {
		if quota, ok := usageCommandPlanQuota[strings.ToLower(*planID)]; ok {
			total := quota
			monthlyTotal = &total
		}
	}
	var monthlyUsed *float64
	if monthlyTotal != nil {
		used := usageMonthlyUsed(*monthlyTotal, monthlyRemaining)
		monthlyUsed = &used
	}
	limits := usageRecord(creditsBody["windowLimits"])
	limited := false
	if value := boolean(limits["limited"]); value != nil {
		limited = *value
	}
	windows := []UsageWindow{}
	if limited {
		if window := usageCommandWindow("five_hour", "5 小时", usageRecord(limits["fiveHour"])); window != nil {
			windows = append(windows, *window)
		}
		if window := usageCommandWindow("weekly", "本周", usageRecord(limits["weekly"])); window != nil {
			windows = append(windows, *window)
		}
		if monthlyTotal != nil && monthlyUsed != nil {
			windows = append(windows, usagePercentWindow("monthly", "本月", (*monthlyUsed / *monthlyTotal)*100,
				parseDate(subscription["currentPeriodEnd"]),
				usageWindowDetails{Used: monthlyUsed, Limit: monthlyTotal, Unit: providerStringPointer("USD")}))
		}
	} else if monthlyTotal != nil && monthlyUsed != nil {
		windows = append(windows, usagePercentWindow("monthly", "本月", (*monthlyUsed / *monthlyTotal)*100,
			parseDate(subscription["currentPeriodEnd"]),
			usageWindowDetails{Used: monthlyUsed, Limit: monthlyTotal, Unit: providerStringPointer("USD")}))
	}
	discovered := usageDiscoverOpenAiCompatible(UsageProviderCommandGoat, credential, prices)
	configuredKeys := usageOpenCodeConfiguredModelKeys(openCodeConfig, []string{"command-goat", "commandcode"})
	models := discovered
	if len(models) == 0 {
		baseURL := credential.BaseURL
		if baseURL == "" {
			baseURL = usageDefaultBaseURLs[UsageProviderCommandGoat]
		}
		models = usageFallbackModels(configuredKeys, UsageProviderCommandGoat, baseURL, prices)
	}
	plan := usageBasePlan(UsageProviderCommandGoat, true, usageStatusFor(windows))
	planName := "Coding Plan"
	if planID != nil {
		if named, ok := usageCommandPlanName[strings.ToLower(*planID)]; ok {
			planName = named
		} else {
			planName = *planID
		}
	}
	plan.Plan = providerStringPointer(planName)
	plan.CredentialSource = providerStringPointer(credential.Source)
	info := usageCredentialInfo(credential)
	plan.Credential = &info
	plan.Windows = windows
	plan.Models = models
	plan.Balance = &UsageBalance{
		Remaining: &monthlyRemaining, Used: monthlyUsed, Total: monthlyTotal,
		Currency: providerStringPointer("USD"), Unit: providerStringPointer("$"),
	}
	plan.Details = UsageDetails{
		{Key: "已购额度", Value: usageNumberValue(credits["purchasedCredits"])},
		{Key: "赠送额度", Value: usageNumberValue(credits["freeCredits"])},
		{Key: "月度剩余", Value: monthlyRemaining},
	}
	return plan, nil
}

// usageMonthlyUsed is Math.max(0, total - remaining).
func usageMonthlyUsed(total, remaining float64) float64 {
	value := total - remaining
	if value < 0 {
		return 0
	}
	return value
}

// usageDeepSeekCredential resolves the DeepSeek credential.
func usageDeepSeekCredential(config *GraphConfig, env map[string]string) *usageCredential {
	return usageFirstCredential(
		usageSelectedCredential(env, UsageProviderDeepSeek, []string{"DEEPSEEK_API_KEY"}, usageDefaultBaseURLs[UsageProviderDeepSeek]),
		usageConfigCredential(config, env, UsageProviderDeepSeek, func(entry ConfiguredModel) bool {
			return strings.Contains(entry.BaseUrl, "api.deepseek.com") || strings.Contains(strings.ToLower(entry.Provider), "deepseek")
		}),
	)
}

// usageFetchDeepSeek reads the DeepSeek account balance.
func usageFetchDeepSeek(credential *usageCredential, prices []ModelPrice) (UsagePlan, error) {
	status, _, raw, err := usageFetch("GET", usageDeepSeekURL, map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
	}, nil, usageRequestTimeoutMs)
	if err != nil {
		return UsagePlan{}, err
	}
	body, err := usageResponseJSON(status, raw, "DeepSeek 余额")
	if err != nil {
		return UsagePlan{}, err
	}
	infos := []map[string]any{}
	for _, value := range usageArray(body["balance_infos"]) {
		if record := usageRecord(value); record != nil {
			infos = append(infos, record)
		}
	}
	var info map[string]any
	for _, candidate := range infos {
		if currency := usageText(candidate["currency"]); currency != nil && strings.ToUpper(*currency) == "CNY" {
			info = candidate
			break
		}
	}
	if info == nil {
		for _, candidate := range infos {
			if number(candidate["total_balance"]) != nil {
				info = candidate
				break
			}
		}
	}
	if info == nil && len(infos) > 0 {
		info = infos[0]
	}
	remaining := 0.0
	if value := number(info["total_balance"]); value != nil {
		remaining = *value
	}
	currency := "CNY"
	if value := usageText(info["currency"]); value != nil {
		currency = *value
	}
	available := true
	if value := boolean(body["is_available"]); value != nil {
		available = *value
	}
	discovered := usageDiscoverOpenAiCompatible(UsageProviderDeepSeek, credential, prices)
	models := discovered
	if len(models) == 0 {
		keys := []string{}
		for _, price := range prices {
			if strings.HasPrefix(strings.ToLower(price.ModelID), "deepseek-") {
				keys = append(keys, price.ModelID)
			}
		}
		baseURL := credential.BaseURL
		if baseURL == "" {
			baseURL = usageDefaultBaseURLs[UsageProviderDeepSeek]
		}
		models = usageFallbackModels(keys, UsageProviderDeepSeek, baseURL, prices)
	}
	plan := usageBasePlan(UsageProviderDeepSeek, true, UsageStatusOK)
	if !available {
		plan.Status = UsageStatusLimited
	}
	plan.Plan = providerStringPointer("API 余额")
	plan.CredentialSource = providerStringPointer(credential.Source)
	info2 := usageCredentialInfo(credential)
	plan.Credential = &info2
	plan.Models = models
	unit := "$"
	if currency == "CNY" {
		unit = "¥"
	}
	plan.Balance = &UsageBalance{Remaining: &remaining, Currency: providerStringPointer(currency), Unit: providerStringPointer(unit)}
	availableLabel := "可用"
	if !available {
		availableLabel = "余额不足"
	}
	plan.Details = UsageDetails{
		{Key: "可用状态", Value: availableLabel},
		{Key: "赠送余额", Value: usageNumberValue(info["granted_balance"])},
		{Key: "充值余额", Value: usageNumberValue(info["topped_up_balance"])},
	}
	return plan, nil
}

// usageDecodeJwtPayload reads the payload of a JWT.
func usageDecodeJwtPayload(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	part := parts[1]
	if part == "" {
		return nil
	}
	padding := (4 - len(part)%4) % 4
	decoded, err := base64.RawURLEncoding.DecodeString(part + strings.Repeat("=", padding))
	if err != nil {
		return nil
	}
	var parsed any
	if err := json.Unmarshal(decoded, &parsed); err != nil {
		return nil
	}
	return usageRecord(parsed)
}

// usageJwtAccountId reads the account id a Codex token names.
func usageJwtAccountId(token string) *string {
	payload := usageDecodeJwtPayload(token)
	auth := usageRecord(payload["https://api.openai.com/auth"])
	organizations := []map[string]any{}
	for _, value := range usageArray(payload["organizations"]) {
		if record := usageRecord(value); record != nil {
			organizations = append(organizations, record)
		}
	}
	if value := usageText(payload["chatgpt_account_id"]); value != nil {
		return value
	}
	if value := usageText(auth["chatgpt_account_id"]); value != nil {
		return value
	}
	if len(organizations) > 0 {
		return usageText(organizations[0]["id"])
	}
	return nil
}

// usageChatGptCredential resolves the ChatGPT credential.
func usageChatGptCredential(home string, env map[string]string) (*usageCredential, error) {
	envToken := usageSelectedCredential(env, UsageProviderChatGPT, []string{"GRAPH_CHATGPT_ACCESS_TOKEN", "CHATGPT_ACCESS_TOKEN"}, usageDefaultBaseURLs[UsageProviderChatGPT])
	if envToken != nil {
		envToken.AccountID = usageText(env["GRAPH_CHATGPT_ACCOUNT_ID"])
		return envToken, nil
	}
	path := strings.TrimSpace(env["GRAPH_CODEX_AUTH_PATH"])
	if path == "" {
		path = filepath.Join(home, ".codex", "auth.json")
	}
	raw, err := readUsageJSONSafe(path)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	root := usageRecord(raw)
	tokens := usageRecord(root["tokens"])
	accessToken := usageText(tokens["access_token"])
	if root == nil || accessToken == nil {
		return nil, errors.New("Codex auth.json 缺少 tokens.access_token")
	}
	accountID := usageText(tokens["account_id"])
	if accountID == nil {
		accountID = usageJwtAccountId(*accessToken)
	}
	return &usageCredential{
		ID: string(UsageProviderChatGPT), SecretRef: usageSubscriptionSecretRefs[UsageProviderChatGPT],
		Configured: true, Value: *accessToken, AccountID: accountID,
		Source: "Codex CLI 登录", BaseURL: usageDefaultBaseURLs[UsageProviderChatGPT],
	}, nil
}

// usageChatGptLabel names a Codex quota window.
func usageChatGptLabel(seconds *float64) string {
	if seconds == nil {
		return "用量窗口"
	}
	if *seconds <= 6*3600 {
		return "5 小时"
	}
	if *seconds <= 8*86400 {
		return "本周"
	}
	if *seconds <= 32*86400 {
		return "本月"
	}
	days := int(math.Round(*seconds / 86400))
	if days < 1 {
		days = 1
	}
	return strconv.Itoa(days) + " 天"
}

// usageCodexWindows reads the quota windows of a Codex reply.
func usageCodexWindows(body map[string]any) []UsageWindow {
	windows := []UsageWindow{}
	appendWindows := func(rateLimit any, prefix string) {
		limit := usageRecord(rateLimit)
		if limit == nil {
			return
		}
		for index, key := range []string{"primary_window", "secondary_window"} {
			raw := usageRecord(limit[key])
			if raw == nil {
				continue
			}
			percent := number(raw["used_percent"])
			if percent == nil {
				continue
			}
			seconds := number(raw["limit_window_seconds"])
			windows = append(windows, usagePercentWindow(prefix+"-"+strconv.Itoa(index), usageChatGptLabel(seconds), *percent, parseDate(raw["reset_at"]), usageWindowDetails{}))
		}
	}
	appendWindows(body["rate_limit"], "codex")
	for index, raw := range usageArray(body["additional_rate_limits"]) {
		item := usageRecord(raw)
		appendWindows(item["rate_limit"], "additional-"+strconv.Itoa(index))
	}
	return windows
}

// usageFetchChatGpt reads the ChatGPT quota.
func usageFetchChatGpt(credential *usageCredential, prices []ModelPrice) (UsagePlan, error) {
	headers := map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
		"user-agent": "codex-cli",
	}
	if credential.AccountID != nil {
		headers["chatgpt-account-id"] = *credential.AccountID
	}
	status, _, raw, err := usageFetch("GET", usageChatGPTURL, headers, nil, usageRequestTimeoutMs)
	if err != nil {
		return UsagePlan{}, err
	}
	if status == 401 || status == 403 {
		return UsagePlan{}, errors.New("ChatGPT 登录凭据已过期，请重新登录 Codex")
	}
	body, err := usageResponseJSON(status, raw, "ChatGPT 用量")
	if err != nil {
		return UsagePlan{}, err
	}
	windows := usageCodexWindows(body)
	if len(windows) == 0 {
		return UsagePlan{}, errors.New("用量响应中没有可识别的配额窗口")
	}
	credits := usageRecord(body["credits"])
	creditBalance := number(credits["balance"])
	models := usageDiscoverChatGptModels(credential, prices)
	plan := usageBasePlan(UsageProviderChatGPT, true, usageStatusFor(windows))
	planName := "ChatGPT"
	if value := usageText(body["plan_type"]); value != nil {
		planName = *value
	}
	plan.Plan = providerStringPointer(planName)
	plan.CredentialSource = providerStringPointer(credential.Source)
	info := usageCredentialInfo(credential)
	plan.Credential = &info
	plan.Models = models
	plan.Windows = windows
	if creditBalance != nil {
		plan.Balance = &UsageBalance{Remaining: creditBalance, Currency: providerStringPointer("USD"), Unit: providerStringPointer("$")}
	}
	return plan, nil
}

// usageGrokCredential resolves the Grok credential.
func usageGrokCredential(home string, env map[string]string) (*usageCredential, error) {
	envToken := usageSelectedCredential(env, UsageProviderGrok, []string{"GRAPH_GROK_ACCESS_TOKEN", "GROK_ACCESS_TOKEN"}, usageDefaultBaseURLs[UsageProviderGrok])
	if envToken != nil {
		return envToken, nil
	}
	path := strings.TrimSpace(env["GRAPH_GROK_AUTH_PATH"])
	if path == "" {
		path = filepath.Join(home, ".grok", "auth.json")
	}
	raw, err := readUsageJSONSafe(path)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	root := usageRecord(raw)
	if root == nil {
		return nil, errors.New("Grok auth.json 根节点不是对象")
	}
	scopes := make([]string, 0, len(root))
	for scope := range root {
		scopes = append(scopes, scope)
	}
	sort.Strings(scopes)
	type entry struct {
		scope string
		value map[string]any
	}
	entries := []entry{}
	for _, scope := range scopes {
		if value := usageRecord(root[scope]); value != nil {
			entries = append(entries, entry{scope: scope, value: value})
		}
	}
	var selected *entry
	for index := range entries {
		if strings.HasPrefix(entries[index].scope, "https://auth.x.ai::") && usageText(entries[index].value["key"]) != nil {
			selected = &entries[index]
			break
		}
	}
	if selected == nil {
		for index := range entries {
			if strings.Contains(entries[index].scope, "/sign-in") && usageText(entries[index].value["key"]) != nil {
				selected = &entries[index]
				break
			}
		}
	}
	if selected == nil {
		return nil, errors.New("Grok auth.json 中没有可用的 access token")
	}
	accessToken := usageText(selected.value["key"])
	return &usageCredential{
		ID: string(UsageProviderGrok), SecretRef: usageSubscriptionSecretRefs[UsageProviderGrok],
		Configured: true, Value: *accessToken, Source: "Grok CLI 登录",
		BaseURL: usageDefaultBaseURLs[UsageProviderGrok],
	}, nil
}

// usageProtoField is one fixed32 field of a protobuf scan.
type usageProtoField struct {
	Path  []int
	Value float64
	Order int
}

// usageProtoVarint is one varint field of a protobuf scan.
type usageProtoVarint struct {
	Path  []int
	Value float64
}

// usageProtoScan collects the fields of a protobuf reply.
type usageProtoScan struct {
	Fixed32 []usageProtoField
	Varint  []usageProtoVarint
}

// usageReadVarint reads one protobuf varint.
func usageReadVarint(data []byte, cursor *int) (float64, bool) {
	value := 0.0
	shift := 0
	for *cursor < len(data) && shift < 64 {
		current := data[*cursor]
		*cursor++
		value += float64(current&0x7f) * math.Pow(2, float64(shift))
		if current&0x80 == 0 {
			return value, true
		}
		shift += 7
	}
	return 0, false
}

// usageScanProtobuf walks a protobuf reply and collects its fields.
func usageScanProtobuf(data []byte, depth int, path []int, order *int, scan *usageProtoScan) {
	cursor := 0
	for cursor < len(data) {
		fieldStart := cursor
		key, ok := usageReadVarint(data, &cursor)
		if !ok || key == 0 {
			cursor = fieldStart + 1
			continue
		}
		fieldNumber := int(key) / 8
		wireType := int(key) % 8
		fieldPath := append(append([]int{}, path...), fieldNumber)
		switch wireType {
		case 0:
			value, read := usageReadVarint(data, &cursor)
			if !read {
				cursor = fieldStart + 1
				continue
			}
			scan.Varint = append(scan.Varint, usageProtoVarint{Path: fieldPath, Value: value})
		case 1:
			cursor += 8
		case 2:
			length, read := usageReadVarint(data, &cursor)
			if !read || length < 0 || cursor+int(length) > len(data) {
				cursor = fieldStart + 1
				continue
			}
			if depth < 4 {
				usageScanProtobuf(data[cursor:cursor+int(length)], depth+1, fieldPath, order, scan)
			}
			cursor += int(length)
		case 5:
			if cursor+4 > len(data) {
				return
			}
			value := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[cursor : cursor+4])))
			scan.Fixed32 = append(scan.Fixed32, usageProtoField{Path: fieldPath, Value: value, Order: *order})
			*order++
			cursor += 4
		default:
			cursor = fieldStart + 1
		}
	}
}

// usageGrpcFrames splits a gRPC-web reply into its message frames.
func usageGrpcFrames(data []byte) [][]byte {
	frames := [][]byte{}
	cursor := 0
	for cursor < len(data) {
		if cursor+5 > len(data) {
			return [][]byte{}
		}
		flags := data[cursor]
		length := binary.BigEndian.Uint32(data[cursor+1 : cursor+5])
		start := cursor + 5
		end := start + int(length)
		if end > len(data) || end < start {
			return [][]byte{}
		}
		if flags&0x80 == 0 {
			frames = append(frames, data[start:end])
		}
		cursor = end
	}
	return frames
}

// usageGrokUsage is the Grok quota the billing reply reports.
type usageGrokUsage struct {
	UsedPercent float64
	ResetAt     *int64
}

// usageParseGrokBilling reads the Grok billing reply.
func usageParseGrokBilling(data []byte, now int64) (usageGrokUsage, error) {
	payloads := usageGrpcFrames(data)
	if len(payloads) == 0 && len(data) > 0 && (data[0]>>3) > 0 {
		switch int(data[0] & 7) {
		case 0, 1, 2, 5:
			payloads = [][]byte{data}
		}
	}
	if len(payloads) == 0 {
		return usageGrokUsage{}, errors.New("Grok 账单响应没有可解析的 protobuf 数据")
	}
	scan := &usageProtoScan{}
	order := 0
	for _, payload := range payloads {
		usageScanProtobuf(payload, 0, nil, &order, scan)
	}
	candidates := []usageProtoField{}
	for _, field := range scan.Fixed32 {
		if len(field.Path) == 0 || field.Path[len(field.Path)-1] != 1 {
			continue
		}
		if math.IsNaN(field.Value) || math.IsInf(field.Value, 0) {
			continue
		}
		if field.Value < 0 || field.Value > 100 {
			continue
		}
		candidates = append(candidates, field)
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if len(candidates[left].Path) != len(candidates[right].Path) {
			return len(candidates[left].Path) < len(candidates[right].Path)
		}
		return candidates[left].Order < candidates[right].Order
	})
	var percent *float64
	if len(candidates) > 0 {
		value := candidates[0].Value
		percent = &value
	}
	resetCandidates := []usageProtoVarint{}
	for _, field := range scan.Varint {
		if field.Value < 1_700_000_000 || field.Value > 2_100_000_000 {
			continue
		}
		if field.Value*1000 <= float64(now) {
			continue
		}
		resetCandidates = append(resetCandidates, field)
	}
	var resetAt *int64
	for _, field := range resetCandidates {
		if usageJoinProtoPath(field.Path) == "1.5.1" {
			value := int64(field.Value * 1000)
			resetAt = &value
			break
		}
	}
	if resetAt == nil && len(resetCandidates) > 0 {
		sorted := append([]usageProtoVarint{}, resetCandidates...)
		sort.SliceStable(sorted, func(left, right int) bool { return sorted[left].Value < sorted[right].Value })
		value := int64(sorted[0].Value * 1000)
		resetAt = &value
	}
	hasPeriod := false
	for _, field := range scan.Varint {
		if len(field.Path) >= 2 && field.Path[0] == 1 && field.Path[1] == 6 {
			hasPeriod = true
			break
		}
	}
	if !hasPeriod {
		for _, field := range scan.Varint {
			if usageJoinProtoPath(field.Path) == "1.8.1" && (field.Value == 1 || field.Value == 2) {
				hasPeriod = true
				break
			}
		}
	}
	if percent == nil && !(resetAt != nil && hasPeriod && len(scan.Fixed32) == 0) {
		return usageGrokUsage{}, errors.New("Grok 账单响应中未找到用量百分比")
	}
	used := 0.0
	if percent != nil {
		used = *percent
	}
	return usageGrokUsage{UsedPercent: used, ResetAt: resetAt}, nil
}

// usageJoinProtoPath renders a protobuf field path.
func usageJoinProtoPath(path []int) string {
	parts := make([]string, 0, len(path))
	for _, value := range path {
		parts = append(parts, strconv.Itoa(value))
	}
	return strings.Join(parts, ".")
}

// usageGrokWindowLabel names a Grok quota window.
func usageGrokWindowLabel(resetAt *int64, now int64) string {
	if resetAt == nil {
		return "额度"
	}
	days := int(math.Round(float64(*resetAt-now) / 86_400_000))
	if days >= 4 && days <= 12 {
		return "本周"
	}
	if days >= 20 && days <= 45 {
		return "本月"
	}
	return "额度"
}

// usageFetchGrok reads the Grok quota.
func usageFetchGrok(credential *usageCredential, now int64, prices []ModelPrice) (UsagePlan, error) {
	status, header, raw, err := usageFetch("POST", usageGrokBillingURL, map[string]string{
		"authorization": "Bearer " + credential.Value, "origin": "https://grok.com",
		"referer": "https://grok.com/?_s=usage", "accept": "*/*",
		"content-type": "application/grpc-web+proto", "x-grpc-web": "1",
		"x-user-agent": "connect-es/2.1.1", "user-agent": "Graph",
	}, []byte{0, 0, 0, 0, 0}, usageRequestTimeoutMs)
	if err != nil {
		return UsagePlan{}, err
	}
	if status == 401 || status == 403 {
		return UsagePlan{}, errors.New("Grok 登录凭据已过期，请重新执行 grok login")
	}
	if status == 408 {
		return UsagePlan{}, errors.New("Grok 账单服务暂时超时")
	}
	if status < 200 || status >= 300 {
		return UsagePlan{}, fmt.Errorf("Grok 账单 HTTP %d", status)
	}
	grpcStatus := header.Get("grpc-status")
	if grpcStatus != "" && grpcStatus != "0" {
		return UsagePlan{}, fmt.Errorf("Grok 账单 gRPC %s", grpcStatus)
	}
	usage, err := usageParseGrokBilling(raw, now)
	if err != nil {
		return UsagePlan{}, err
	}
	windows := []UsageWindow{usagePercentWindow("credits", usageGrokWindowLabel(usage.ResetAt, now), usage.UsedPercent, usage.ResetAt, usageWindowDetails{})}
	discovered := usageDiscoverOpenAiCompatible(UsageProviderGrok, credential, prices)
	models := discovered
	if len(models) == 0 {
		keys := []string{}
		for _, price := range prices {
			lowered := strings.ToLower(price.ModelID)
			if strings.HasPrefix(lowered, "grok-") || strings.HasPrefix(lowered, "grokbuild") {
				keys = append(keys, price.ModelID)
			}
		}
		baseURL := credential.BaseURL
		if baseURL == "" {
			baseURL = usageDefaultBaseURLs[UsageProviderGrok]
		}
		models = usageFallbackModels(keys, UsageProviderGrok, baseURL, prices)
	}
	plan := usageBasePlan(UsageProviderGrok, true, usageStatusFor(windows))
	plan.Plan = providerStringPointer("SuperGrok")
	plan.CredentialSource = providerStringPointer(credential.Source)
	info := usageCredentialInfo(credential)
	plan.Credential = &info
	plan.Windows = windows
	plan.Models = models
	return plan, nil
}

// usageParseModelPrices reads the local price table.
func usageParseModelPrices(raw any) []ModelPrice {
	prices := []ModelPrice{}
	for _, value := range usageArray(usageRecord(raw)["models"]) {
		item := usageRecord(value)
		if item == nil {
			continue
		}
		modelID := usageText(item["modelId"])
		if modelID == nil {
			continue
		}
		input := number(item["inputCostPerMillion"])
		output := number(item["outputCostPerMillion"])
		cacheRead := number(item["cacheReadCostPerMillion"])
		cacheCreation := number(item["cacheCreationCostPerMillion"])
		if input == nil || output == nil || cacheRead == nil || cacheCreation == nil {
			continue
		}
		displayName := *modelID
		if value := usageText(item["displayName"]); value != nil {
			displayName = *value
		}
		prices = append(prices, ModelPrice{
			ModelID: *modelID, DisplayName: displayName,
			InputCostPerMillion: *input, OutputCostPerMillion: *output,
			CacheReadCostPerMillion: *cacheRead, CacheCreationCostPerMillion: *cacheCreation,
		})
	}
	return prices
}

// usagePriceFor finds the archived price of a model.
func usagePriceFor(modelID string, prices []ModelPrice) *ModelPrice {
	normalized := strings.ToLower(modelID)
	for index := range prices {
		if strings.ToLower(prices[index].ModelID) == normalized {
			return &prices[index]
		}
	}
	for index := range prices {
		lowered := strings.ToLower(prices[index].ModelID)
		if strings.HasSuffix(normalized, lowered) || strings.HasSuffix(lowered, normalized) {
			return &prices[index]
		}
	}
	return nil
}

// usageSubscriptionModelValues are the optional overrides of a model entry.
type usageSubscriptionModelValues struct {
	ContextWindow *int
	MaxTokens     *int
	Reasoning     *bool
	Headers       map[string]string
}

// usageSubscriptionModel builds one subscription model entry.
func usageSubscriptionModel(id string, name string, provider UsageProviderId, api SubscriptionModelApi, baseURL string, prices []ModelPrice, values usageSubscriptionModelValues) SubscriptionModel {
	model := SubscriptionModel{
		ID: id, Name: name, API: api, BaseURL: baseURL,
		ContextWindow: 131_072, MaxTokens: 8_192,
		Reasoning: !usageNonReasoningPattern.MatchString(id),
		Supported: api != SubscriptionModelApiResponses,
	}
	if values.ContextWindow != nil {
		model.ContextWindow = *values.ContextWindow
	}
	if values.MaxTokens != nil {
		model.MaxTokens = *values.MaxTokens
	}
	if values.Reasoning != nil {
		model.Reasoning = *values.Reasoning
	}
	if price := usagePriceFor(id, prices); price != nil {
		input := price.InputCostPerMillion
		output := price.OutputCostPerMillion
		cacheRead := price.CacheReadCostPerMillion
		cacheCreation := price.CacheCreationCostPerMillion
		model.InputCostPerMillion = &input
		model.OutputCostPerMillion = &output
		model.CacheReadCostPerMillion = &cacheRead
		model.CacheCreationCostPerMillion = &cacheCreation
	}
	if values.Headers != nil {
		model.Headers = values.Headers
	}
	return model
}

// usageOpenAiModels reads the model list of an OpenAI-compatible endpoint.
func usageOpenAiModels(body map[string]any, provider UsageProviderId, baseURL string, api SubscriptionModelApi, prices []ModelPrice) []SubscriptionModel {
	rows := usageArray(body["data"])
	if len(rows) == 0 {
		rows = usageArray(body["models"])
	}
	if len(rows) == 0 {
		rows = usageArray(body)
	}
	models := []SubscriptionModel{}
	indexes := map[string]int{}
	for _, raw := range rows {
		if text, ok := raw.(string); ok {
			model := usageSubscriptionModel(text, text, provider, api, baseURL, prices, usageSubscriptionModelValues{})
			if existing, seen := indexes[model.ID]; seen {
				models[existing] = model
				continue
			}
			indexes[model.ID] = len(models)
			models = append(models, model)
			continue
		}
		item := usageRecord(raw)
		if item == nil {
			continue
		}
		id := usageText(item["id"])
		if id == nil {
			id = usageText(item["model"])
		}
		if id == nil {
			id = usageText(item["slug"])
		}
		if id == nil {
			continue
		}
		limit := usageRecord(item["limit"])
		contextWindow := 131_072
		if value := number(item["context_window"]); value != nil {
			contextWindow = int(*value)
		} else if value := number(item["contextWindow"]); value != nil {
			contextWindow = int(*value)
		} else if value := number(limit["context"]); value != nil {
			contextWindow = int(*value)
		}
		maxTokens := 8_192
		if value := number(item["max_output_tokens"]); value != nil {
			maxTokens = int(*value)
		} else if value := number(item["maxTokens"]); value != nil {
			maxTokens = int(*value)
		} else if value := number(limit["output"]); value != nil {
			maxTokens = int(*value)
		}
		reasoning := !usageNonReasoningPattern.MatchString(*id)
		if value := boolean(item["reasoning"]); value != nil {
			reasoning = *value
		}
		name := *id
		if value := usageText(item["name"]); value != nil {
			name = *value
		} else if value := usageText(item["display_name"]); value != nil {
			name = *value
		}
		model := usageSubscriptionModel(*id, name, provider, api, baseURL, prices, usageSubscriptionModelValues{
			ContextWindow: &contextWindow, MaxTokens: &maxTokens, Reasoning: &reasoning,
		})
		if existing, seen := indexes[model.ID]; seen {
			models[existing] = model
			continue
		}
		indexes[model.ID] = len(models)
		models = append(models, model)
	}
	return models
}

// usageFallbackModels builds the model list from known model ids.
func usageFallbackModels(keys []string, provider UsageProviderId, baseURL string, prices []ModelPrice) []SubscriptionModel {
	matches := keys
	if len(matches) == 0 {
		for _, price := range prices {
			matches = append(matches, price.ModelID)
		}
	}
	unique := []string{}
	seen := map[string]bool{}
	for _, id := range matches {
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	models := []SubscriptionModel{}
	for _, id := range unique {
		displayName := id
		if price := usagePriceFor(id, prices); price != nil {
			displayName = price.DisplayName
		}
		models = append(models, usageSubscriptionModel(id, displayName, provider, SubscriptionModelApiOpenAICompletions, baseURL, prices, usageSubscriptionModelValues{}))
	}
	return models
}

// usageOpenCodeConfiguredModelKeys reads the model ids the local OpenCode
// configuration names.
func usageOpenCodeConfiguredModelKeys(config any, ids []string) []string {
	providers := usageRecord(usageRecord(config)["provider"])
	if providers == nil {
		return []string{}
	}
	names := make([]string, 0, len(providers))
	for name := range providers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !usageContainsFold(ids, name) {
			continue
		}
		models := usageRecord(usageRecord(providers[name])["models"])
		keys := make([]string, 0, len(models))
		for key := range models {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return keys
	}
	return []string{}
}

// usageDiscoverOpenCodeModels reads the models an OpenCode Go subscription
// exposes.
func usageDiscoverOpenCodeModels(credential *usageCredential, prices []ModelPrice, openCodeConfig any) []SubscriptionModel {
	baseURL := credential.BaseURL
	if baseURL == "" {
		baseURL = usageDefaultBaseURLs[UsageProviderOpenCodeGo]
	}
	configuredKeys := usageOpenCodeConfiguredModelKeys(openCodeConfig, []string{"opencode-go"})
	status, _, raw, err := usageFetch("GET", usageModelsDevURL, map[string]string{"accept": "application/json"}, nil, usageRequestTimeoutMs)
	if err != nil {
		return usageOpenCodeFallbackModels(configuredKeys, baseURL, prices)
	}
	body, err := usageResponseJSON(status, raw, "models.dev")
	if err != nil {
		return usageOpenCodeFallbackModels(configuredKeys, baseURL, prices)
	}
	models := usageRecord(usageRecord(body["opencode-go"])["models"])
	if models == nil {
		return usageFallbackModels(configuredKeys, UsageProviderOpenCodeGo, baseURL, prices)
	}
	ids := map[string]bool{}
	for id := range models {
		ids[id] = true
	}
	for id := range usageOpenCodeModels {
		ids[id] = true
	}
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	result := []SubscriptionModel{}
	for _, id := range ordered {
		item := usageRecord(models[id])
		limit := usageRecord(item["limit"])
		pi, hasPi := usageOpenCodeModels[id]
		api := SubscriptionModelApiOpenAICompletions
		if hasPi {
			if pi.API == "anthropic-messages" {
				api = SubscriptionModelApiAnthropicMessages
			} else if pi.API == "openai-responses" {
				api = SubscriptionModelApiResponses
			}
		}
		name := id
		if value := usageText(item["name"]); value != nil {
			name = *value
		} else if hasPi {
			name = pi.Name
		}
		modelBaseURL := baseURL
		if hasPi {
			modelBaseURL = pi.BaseURL
		}
		contextWindow := 131_072
		if hasPi {
			contextWindow = pi.ContextWindow
		} else if value := number(limit["context"]); value != nil {
			contextWindow = int(*value)
		}
		maxTokens := 8_192
		if hasPi {
			maxTokens = pi.MaxTokens
		} else if value := number(limit["output"]); value != nil {
			maxTokens = int(*value)
		}
		reasoning := true
		if hasPi {
			reasoning = pi.Reasoning
		} else if value := boolean(item["reasoning"]); value != nil {
			reasoning = *value
		}
		result = append(result, usageSubscriptionModel(id, name, UsageProviderOpenCodeGo, api, modelBaseURL, prices, usageSubscriptionModelValues{
			ContextWindow: &contextWindow, MaxTokens: &maxTokens, Reasoning: &reasoning,
			Headers: map[string]string{"x-opencode-session": "graph-console"},
		}))
	}
	return result
}

// usageOpenCodeFallbackModels builds the OpenCode Go model list without the
// models.dev catalogue.
func usageOpenCodeFallbackModels(configuredKeys []string, baseURL string, prices []ModelPrice) []SubscriptionModel {
	models := usageFallbackModels(configuredKeys, UsageProviderOpenCodeGo, baseURL, prices)
	for index := range models {
		models[index].Headers = map[string]string{"x-opencode-session": "graph-console"}
	}
	return models
}

// usageDiscoverOpenAiCompatible reads the model list of an OpenAI-compatible
// subscription endpoint.
func usageDiscoverOpenAiCompatible(provider UsageProviderId, credential *usageCredential, prices []ModelPrice) []SubscriptionModel {
	baseURL := credential.BaseURL
	if baseURL == "" {
		baseURL = usageDefaultBaseURLs[provider]
	}
	status, _, raw, err := usageFetch("GET", strings.TrimRight(baseURL, "/")+"/models", map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
	}, nil, usageRequestTimeoutMs)
	if err != nil {
		return []SubscriptionModel{}
	}
	body, err := usageResponseJSON(status, raw, usagePlanBlueprints[provider].Name+" 模型")
	if err != nil {
		return []SubscriptionModel{}
	}
	return usageOpenAiModels(body, provider, baseURL, SubscriptionModelApiOpenAICompletions, prices)
}

// usageDiscoverChatGptModels reads the model list a ChatGPT subscription
// exposes.
func usageDiscoverChatGptModels(credential *usageCredential, prices []ModelPrice) []SubscriptionModel {
	headers := map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
		"user-agent": "codex-cli",
	}
	if credential.AccountID != nil {
		headers["chatgpt-account-id"] = *credential.AccountID
	}
	status, _, raw, err := usageFetch("GET", usageChatGPTModelsURL, headers, nil, usageRequestTimeoutMs)
	if err != nil {
		return usageChatGptFallbackModels(prices)
	}
	body, err := usageResponseJSON(status, raw, "ChatGPT 模型")
	if err != nil {
		return usageChatGptFallbackModels(prices)
	}
	return usageOpenAiModels(body, UsageProviderChatGPT, usageDefaultBaseURLs[UsageProviderChatGPT], SubscriptionModelApiResponses, prices)
}

// usageChatGptFallbackModels builds the ChatGPT model list from the archived
// prices.
func usageChatGptFallbackModels(prices []ModelPrice) []SubscriptionModel {
	keys := []string{}
	for _, price := range prices {
		lowered := strings.ToLower(price.ModelID)
		if strings.HasPrefix(lowered, "gpt-") || strings.HasPrefix(lowered, "codex") {
			keys = append(keys, price.ModelID)
		}
	}
	return usageFallbackModels(keys, UsageProviderChatGPT, usageDefaultBaseURLs[UsageProviderChatGPT], prices)
}

// usageSummarize counts the plans by state.
func usageSummarize(plans []UsagePlan) UsageSummary {
	summary := UsageSummary{}
	for _, plan := range plans {
		if plan.Configured {
			summary.Configured++
			if plan.Status != UsageStatusError {
				summary.Connected++
			}
		} else {
			summary.Unconfigured++
		}
		switch plan.Status {
		case UsageStatusWarning:
			summary.Warnings++
		case UsageStatusLimited:
			summary.Limited++
		}
	}
	return summary
}

// usageService is the live usage service.
type usageService struct {
	mu           sync.Mutex
	env          map[string]string
	home         string
	loadConfig   func() (GraphConfig, map[string]string)
	pricingPath  string
	openCodePath string
	cached       *UsageSnapshot
	loading      bool
	loaded       chan struct{}
	lastResult   UsageSnapshot
	lastError    error
}

// CreateUsageService is createUsageService. It reads the local subscription
// configuration and the vendor quotas; nothing it returns carries a secret
// value.
func CreateUsageService(options UsageServiceOptions) UsageService {
	env := options.Env
	if env == nil {
		env = osEnviron()
	}
	home := options.Home
	if home == "" {
		home = strings.TrimSpace(env["HOME"])
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return &usageService{
		env: env, home: home, loadConfig: options.LoadConfig,
		pricingPath:  filepath.Join(home, ".cc-switch", "model-pricing.json"),
		openCodePath: filepath.Join(home, ".config", "opencode", "opencode.json"),
	}
}

// usageCurrentConfig reads the configuration and the environment the service
// works with.
func (service *usageService) usageCurrentConfig() (GraphConfig, map[string]string) {
	if service.loadConfig != nil {
		return service.loadConfig()
	}
	return EmptyGraphConfig(), service.env
}

// usageCredentialInventory resolves the credential of every platform.
func (service *usageService) usageCredentialInventory(config GraphConfig, env map[string]string, openCodeConfig any) map[UsageProviderId]*usageCredential {
	chatgpt, chatgptError := usageChatGptCredential(service.home, env)
	if chatgptError != nil {
		chatgpt = nil
	}
	grok, grokError := usageGrokCredential(service.home, env)
	if grokError != nil {
		grok = nil
	}
	return map[UsageProviderId]*usageCredential{
		UsageProviderOpenCodeGo:  usageOpenCodeCredential(&config, env, openCodeConfig),
		UsageProviderCommandGoat: usageCommandGoatCredential(&config, env, openCodeConfig),
		UsageProviderDeepSeek:    usageDeepSeekCredential(&config, env),
		UsageProviderChatGPT:     chatgpt,
		UsageProviderGrok:        grok,
	}
}

// usageLoadPricing reads the local price table.
func (service *usageService) usageLoadPricing() ModelPricingSnapshot {
	snapshot := ModelPricingSnapshot{Source: "~/.cc-switch/model-pricing.json", Models: []ModelPrice{}}
	if info, err := os.Stat(service.pricingPath); err == nil {
		millis := info.ModTime().UnixMilli()
		snapshot.UpdatedAt = &millis
	}
	raw, err := readUsageJSONSafe(service.pricingPath)
	if err != nil || raw == nil {
		return snapshot
	}
	snapshot.Models = usageParseModelPrices(raw)
	return snapshot
}

// usageJob is one plan the snapshot reads.
type usageJob struct {
	platform   UsageProviderId
	planID     string
	account    *UsageAccount
	credential *usageCredential
	run        func() (UsagePlan, error)
}

// usageLoad reads every platform and builds the snapshot.
func (service *usageService) usageLoad() (UsageSnapshot, error) {
	generatedAt := NowMillis()
	config, env := service.usageCurrentConfig()
	openCodeConfig, err := readUsageJSONSafe(service.openCodePath)
	if err != nil {
		openCodeConfig = nil
	}
	pricing := service.usageLoadPricing()
	credentials := service.usageCredentialInventory(config, env, openCodeConfig)
	prices := pricing.Models

	runners := map[UsageProviderId]func(*usageCredential) (UsagePlan, error){
		UsageProviderOpenCodeGo: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchOpenCode(credential, generatedAt, prices, openCodeConfig)
		},
		UsageProviderCommandGoat: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchCommandGoat(credential, generatedAt, prices, openCodeConfig)
		},
		UsageProviderDeepSeek: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchDeepSeek(credential, prices)
		},
		UsageProviderChatGPT: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchChatGpt(credential, prices)
		},
		UsageProviderGrok: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchGrok(credential, generatedAt, prices)
		},
	}

	jobs := []usageJob{}
	for _, platform := range usageProviderOrder {
		credential := credentials[platform]
		jobs = append(jobs, usageJob{
			platform: platform, planID: string(platform), account: nil, credential: credential,
			run: func() (UsagePlan, error) {
				if credential == nil {
					return usageBasePlan(platform, false, UsageStatusUnconfigured), nil
				}
				return runners[platform](credential)
			},
		})
		for _, account := range usagePlatformAccountCredentials(&config, env, platform) {
			// The credential already reported as the platform's primary one is
			// not repeated.
			if credential != nil && account.ID == credential.ID {
				continue
			}
			accountCopy := account
			jobs = append(jobs, usageJob{
				platform: platform, planID: string(platform) + "#" + account.ID,
				account:    &UsageAccount{ID: account.ID, Name: account.DisplayNameValue()},
				credential: &accountCopy,
				run: func() (UsagePlan, error) {
					if accountCopy.Value == "" {
						return usageBasePlan(platform, false, UsageStatusUnconfigured), nil
					}
					return runners[platform](&accountCopy)
				},
			})
		}
	}

	plans := make([]UsagePlan, len(jobs))
	// The TypeScript read every platform concurrently; the vendor calls are
	// independent round-trips, so they overlap here too.
	var group sync.WaitGroup
	for index := range jobs {
		group.Add(1)
		go func(position int) {
			defer group.Done()
			job := jobs[position]
			plan, runError := job.run()
			if runError == nil {
				plan.ID = job.planID
				plan.Platform = job.platform
				plan.Account = job.account
				plans[position] = plan
				return
			}
			failed := usageBasePlan(job.platform, true, UsageStatusError)
			failed.ID = job.planID
			failed.Account = job.account
			if job.credential != nil {
				info := usageCredentialInfo(job.credential)
				failed.Credential = &info
				failed.CredentialSource = providerStringPointer(job.credential.Source)
			}
			message := usageErrorMessage(runError)
			failed.Error = &message
			plans[position] = failed
		}(index)
	}
	group.Wait()

	return UsageSnapshot{
		GeneratedAt: generatedAt,
		Plans:       plans,
		Pricing:     pricing,
		Summary:     usageSummarize(plans),
	}, nil
}

// Get returns the usage snapshot. A forced read always refetches; a read that
// is already running is shared with the callers that wait for it.
func (service *usageService) Get(force bool) (UsageSnapshot, error) {
	for {
		service.mu.Lock()
		if !force && service.cached != nil && NowMillis()-service.cached.GeneratedAt < usageCacheTTLMs {
			snapshot := *service.cached
			service.mu.Unlock()
			return snapshot, nil
		}
		if service.loading {
			done := service.loaded
			service.mu.Unlock()
			<-done
			service.mu.Lock()
			result := service.lastResult
			err := service.lastError
			service.mu.Unlock()
			return result, err
		}
		service.loading = true
		service.loaded = make(chan struct{})
		done := service.loaded
		service.mu.Unlock()

		snapshot, err := service.usageLoad()

		service.mu.Lock()
		service.loading = false
		service.lastResult = snapshot
		service.lastError = err
		if err == nil {
			cached := snapshot
			service.cached = &cached
		}
		service.mu.Unlock()
		close(done)
		return snapshot, err
	}
}

// Pricing is the local price snapshot, without querying subscription
// providers.
func (service *usageService) Pricing() (ModelPricingSnapshot, error) {
	return service.usageLoadPricing(), nil
}

// Credentials are the detected subscription providers mapped to the
// credential ref Graph should use.
func (service *usageService) Credentials() (map[string]string, error) {
	config, env := service.usageCurrentConfig()
	openCodeConfig, err := readUsageJSONSafe(service.openCodePath)
	if err != nil {
		openCodeConfig = nil
	}
	inventory := service.usageCredentialInventory(config, env, openCodeConfig)
	credentials := map[string]string{}
	for _, provider := range usageProviderOrder {
		if credential := inventory[provider]; credential != nil {
			credentials[string(provider)] = credential.SecretRef
		}
	}
	return credentials, nil
}

// SecretValues are the secret values imported from local subscription
// configuration or login files. They stay inside the daemon.
func (service *usageService) SecretValues() map[string]string {
	config, env := service.usageCurrentConfig()
	openCodeConfig, err := readUsageJSONSafe(service.openCodePath)
	if err != nil {
		openCodeConfig = nil
	}
	inventory := service.usageCredentialInventory(config, env, openCodeConfig)
	values := map[string]string{}
	for _, provider := range usageProviderOrder {
		if credential := inventory[provider]; credential != nil {
			values[credential.SecretRef] = credential.Value
		}
	}
	return values
}

// DisplayNameValue is the account name the console shows.
func (credential *usageCredential) DisplayNameValue() string {
	if credential.DisplayName == nil {
		return credential.ID
	}
	return *credential.DisplayName
}

// readUsageJSONSafe reads and parses a JSON file. A missing file is nil; a
// broken file is an error the caller decides about.
func readUsageJSONSafe(path string) (any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}
