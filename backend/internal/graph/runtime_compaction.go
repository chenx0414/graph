package graph

import (
	"encoding/json"
	"math"
	"regexp"
)

// CompactionSettings is the reserve and keep-recent window for one model.
type CompactionSettings struct {
	Enabled          bool `json:"enabled"`
	ReserveTokens    int  `json:"reserveTokens"`
	KeepRecentTokens int  `json:"keepRecentTokens"`
}

// CompactionSettingsFor derives thresholds from the model that will receive the request.
// A window only a few hundred tokens wide still gets a usable reserve: the fixed
// 1024-token floor is capped at half the window so the trigger point never goes negative.
func CompactionSettingsFor(entry struct {
	ContextWindow int
	MaxTokens     int
}) CompactionSettings {
	contextWindow := entry.ContextWindow
	if contextWindow < 1 {
		contextWindow = 1
	}
	maxTokens := entry.MaxTokens
	if maxTokens < 1 {
		maxTokens = 1
	}
	half := contextWindow / 2
	if half < 256 {
		half = 256
	}
	floor := maxTokens
	if floor < 1024 {
		floor = 1024
	}
	reserve := floor
	if half < reserve {
		reserve = half
	}
	if reserve > 16384 {
		reserve = 16384
	}
	quarter := contextWindow / 4
	if quarter < 1024 {
		quarter = 1024
	}
	keep := quarter
	if keep > 20000 {
		keep = 20000
	}
	return CompactionSettings{Enabled: true, ReserveTokens: reserve, KeepRecentTokens: keep}
}

// COMPACTION_INSTRUCTIONS asks for a bounded handoff instead of a growing transcript.
const COMPACTION_INSTRUCTIONS = "This summary is a working handoff for the next turn, not a transcript. Keep the entire summary under roughly 1500 tokens. Write only the handoff. Do not include <analysis>, <summary>, reasoning, or a chronology of the conversation. Drop resolved detail, superseded attempts and stale plans instead of preserving them. Keep only what is needed to continue: the goal, the current state, open blockers, key decisions, exact file paths and the next steps."

var (
	compactionAnalysis = regexp.MustCompile(`(?i)(?:^|\n)\s*<analysis>\s*(?:\n|$)`)
	compactionSummary  = regexp.MustCompile(`(?i)(?:^|\n)\s*<summary>\s*(?:\n|$)`)
	compactionClosed   = regexp.MustCompile(`(?i)(?:^|\n)\s*</summary>\s*$`)
	compactionNoop     = regexp.MustCompile(`^(?:Compaction failed: )?(?:Already compacted|Nothing to compact \(session too small\))$`)
)

// IsLeakedCompactionReply requires the complete leaked handoff structure.
func IsLeakedCompactionReply(text string) bool {
	if len(text) < 2000 {
		return false
	}
	analysis := compactionAnalysis.FindStringIndex(text)
	if analysis == nil || analysis[0] > 500 {
		return false
	}
	summary := compactionSummary.FindStringIndex(text)
	return summary != nil && summary[0] > analysis[0] && compactionClosed.MatchString(text)
}

// IsSummaryLeakRetry reports a session_summary_leak retry code on an object output.
func IsSummaryLeakRetry(output any) bool {
	record, ok := output.(map[string]any)
	if !ok || output == nil {
		return false
	}
	code, _ := record["retryCode"].(string)
	return code == "session_summary_leak"
}

// ShouldCompactContext is true once the recorded context no longer fits beside the reserve.
func ShouldCompactContext(entry struct {
	ContextWindow int
	MaxTokens     int
}, contextTokens *float64) bool {
	if contextTokens == nil || math.IsNaN(*contextTokens) || math.IsInf(*contextTokens, 0) {
		return false
	}
	settings := CompactionSettingsFor(entry)
	window := entry.ContextWindow
	if window < 1 {
		window = 1
	}
	limit := window - settings.ReserveTokens
	if limit < 1 {
		limit = 1
	}
	return *contextTokens > float64(limit)
}

// RecordedContextUsage is one settled invocation's usage string.
type RecordedContextUsage struct {
	Usage     string
	SettledAt float64
	Sequence  *float64
}

// RecordedCompaction is a successful compaction event.
type RecordedCompaction struct {
	Timestamp float64
	Data      string
}

// LatestContextTokens resolves the context size the next turn will send.
// Zero-usage placeholders are ignored. A newer compaction estimate wins.
func LatestContextTokens(completions []RecordedContextUsage, lastCompaction *RecordedCompaction) *float64 {
	var completion *RecordedContextUsage
	for i := range completions {
		parsed, ok := compactionUsage(completions[i].Usage)
		if ok && compactionTokenSum(parsed) > 0 {
			completion = &completions[i]
			break
		}
	}
	var completionTokens *float64
	if completion != nil {
		parsed, _ := compactionUsage(completion.Usage)
		sum := compactionTokenSum(parsed)
		completionTokens = &sum
	}
	if lastCompaction != nil {
		var data struct {
			TokensAfter        *float64 `json:"tokensAfter"`
			CompletionSequence *float64 `json:"completionSequence"`
		}
		if err := json.Unmarshal([]byte(lastCompaction.Data), &data); err == nil {
			summaryIsNewer := completion == nil
			if completion != nil {
				if data.CompletionSequence != nil && completion.Sequence != nil {
					summaryIsNewer = *completion.Sequence <= *data.CompletionSequence
				} else {
					summaryIsNewer = lastCompaction.Timestamp >= completion.SettledAt
				}
			}
			if summaryIsNewer && data.TokensAfter != nil && !math.IsNaN(*data.TokensAfter) && !math.IsInf(*data.TokensAfter, 0) {
				return data.TokensAfter
			}
		}
	}
	return completionTokens
}

func compactionUsage(raw string) (map[string]float64, bool) {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, false
	}
	out := map[string]float64{}
	for _, key := range []string{"input", "output", "cacheRead", "cacheWrite"} {
		if number, ok := asFloat(parsed[key]); ok {
			out[key] = number
		}
	}
	return out, true
}

func compactionTokenSum(parsed map[string]float64) float64 {
	return parsed["input"] + parsed["output"] + parsed["cacheRead"] + parsed["cacheWrite"]
}

// IsCompactionNoop reports Pi's no-op compaction outcomes. Neither is an execution failure.
func IsCompactionNoop(message string) bool {
	return compactionNoop.MatchString(message)
}
