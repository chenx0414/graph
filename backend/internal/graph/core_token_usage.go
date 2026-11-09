package graph

type UsageSource string

const (
	UsageAuthoritative UsageSource = "authoritative"
	UsageAccountDelta  UsageSource = "account_delta"
	UsageEstimated     UsageSource = "estimated"
	UsageUnknown       UsageSource = "unknown"
)

var USAGE_SOURCES = []UsageSource{UsageAuthoritative, UsageAccountDelta, UsageEstimated, UsageUnknown}

type TokenUsage struct {
	Input         int64   `json:"input"`
	Output        int64   `json:"output"`
	CacheRead     int64   `json:"cacheRead"`
	CacheWrite    int64   `json:"cacheWrite"`
	ContextTokens *int64  `json:"contextTokens,omitempty"`
	UsageSource   *string `json:"usageSource,omitempty"`
	DurationMs    *int64  `json:"durationMs,omitempty"`
	FirstTokenMs  *int64  `json:"firstTokenMs,omitempty"`
}

func isUsageSource(value string) bool {
	for _, source := range USAGE_SOURCES {
		if string(source) == value {
			return true
		}
	}
	return false
}

func UsageSourceOf(usage *TokenUsage) UsageSource {
	if usage == nil {
		return UsageUnknown
	}
	if usage.UsageSource == nil {
		return UsageAuthoritative
	}
	if isUsageSource(*usage.UsageSource) {
		return UsageSource(*usage.UsageSource)
	}
	return UsageUnknown
}

func NormalizeTokenUsage(usage TokenUsage) TokenUsage {
	source := string(UsageSourceOf(&usage))
	usage.UsageSource = &source
	return usage
}

func MergeUsageSource(current, next UsageSource) UsageSource {
	if current == UsageUnknown || next == UsageUnknown {
		return UsageUnknown
	}
	if current == UsageEstimated || next == UsageEstimated {
		return UsageEstimated
	}
	if current == UsageAccountDelta || next == UsageAccountDelta {
		return UsageAccountDelta
	}
	return UsageAuthoritative
}

func PromptTokens(usage TokenUsage) int64 {
	return usage.Input + usage.CacheRead + usage.CacheWrite
}

func TokenUsageTotal(usage TokenUsage) int64 {
	return usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite
}
