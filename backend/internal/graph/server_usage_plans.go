package graph

import (
	"encoding/json"
	"sort"
	"strings"

	"bytes"
)

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
