package graph

import (
	"os"
	"regexp"
	"strconv"
	"strings"
)

// CompactionSettings is the reserve and keep-recent window for one model.
type CompactionSettings struct {
	Enabled          bool `json:"enabled"`
	ReserveTokens    int  `json:"reserveTokens"`
	KeepRecentTokens int  `json:"keepRecentTokens"`
}

// CompactionSettingsFor derives thresholds from the model that will receive the request.
//
// The reserve is the room kept free for the summary and the answer: compaction
// starts at 70% of the window, so the summarizer still reads a context that
// fits. The remaining 30% also leaves room for the next few tool results before
// the compaction lands. The summary's own output budget is derived from the
// reserve by the kernel (four fifths of it, capped by the model's limit).
func CompactionSettingsFor(entry struct {
	ContextWindow int
	MaxTokens     int
}) CompactionSettings {
	contextWindow := entry.ContextWindow
	if contextWindow < 1 {
		contextWindow = 1
	}
	reserve := contextWindow * 30 / 100
	if reserve < 1024 {
		reserve = 1024
	}
	// A window only a few hundred tokens wide still gets a usable reserve: the
	// floor is capped at half the window so the trigger point never goes negative.
	half := contextWindow / 2
	if half < 1 {
		half = 1
	}
	if reserve > half {
		reserve = half
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

// IsCompactionNoop reports Pi's no-op compaction outcomes. Neither is an execution failure.
func IsCompactionNoop(message string) bool {
	return compactionNoop.MatchString(message)
}

// COMPACTION_CONTEXT_CEILING caps how far the recorded context may grow before the
// session is compacted.
//
// The provider's window is the limit the session has to respect, and the session
// compacts just before it would overflow. That keeps every token the conversation
// ever produced, and it bills the whole of it again on every request of the next
// cycle: the running production conversations compact at around half a million
// tokens, and each of the requests in between pays for the whole of that prefix.
//
// A ceiling asks for the same compaction with less history behind it. The summary
// the session continues from is the same size either way, and the tokens the
// compaction call reads are the same tokens either way, because a session that
// compacts four times as often summarizes four times as little each time. Only
// the prefix every request carries shrinks.
//
// It is off unless the environment names a ceiling, because how much history a
// task needs is the task's own business.
const COMPACTION_CONTEXT_CEILING = "GRAPH_COMPACTION_CONTEXT_CEILING"

// compactionContextCeiling is the ceiling the environment names, or zero when it names none.
func compactionContextCeiling() int {
	raw := strings.TrimSpace(os.Getenv(COMPACTION_CONTEXT_CEILING))
	if raw == "" {
		return 0
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0
	}
	return value
}
