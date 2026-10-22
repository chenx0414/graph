package graph

// The usage vocabulary of CONTEXT.md's 预算账本: a token count always carries
// the source it came from, and a missing source is never read as zero.

// UsageSource describes where token counts came from.
type UsageSource string

const (
	UsageAuthoritative UsageSource = "authoritative"
	UsageAccountDelta  UsageSource = "account_delta"
	UsageEstimated     UsageSource = "estimated"
	UsageUnknown       UsageSource = "unknown"
)

// USAGE_SOURCES is the provenance vocabulary, strongest last in merge order is not this list order.
var USAGE_SOURCES = []UsageSource{UsageAuthoritative, UsageAccountDelta, UsageEstimated, UsageUnknown}

// TokenUsage is a disjoint token count. Reasoning is part of output.
type TokenUsage struct {
	Input       int64   `json:"input"`
	Output      int64   `json:"output"`
	CacheRead   int64   `json:"cacheRead"`
	CacheWrite  int64   `json:"cacheWrite"`
	UsageSource *string `json:"usageSource,omitempty"`
}

func isUsageSource(value string) bool {
	for _, source := range USAGE_SOURCES {
		if string(source) == value {
			return true
		}
	}
	return false
}

// UsageSourceOf normalizes missing provenance to authoritative and a missing usage to unknown.
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

// NormalizeTokenUsage copies usage with a concrete provenance.
func NormalizeTokenUsage(usage TokenUsage) TokenUsage {
	source := string(UsageSourceOf(&usage))
	usage.UsageSource = &source
	return usage
}

// MergeUsageSource picks the weaker provenance. Unknown beats every other source.
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

// TokenUsageTotal sums the four disjoint counts.
func TokenUsageTotal(usage TokenUsage) int64 {
	return usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite
}
