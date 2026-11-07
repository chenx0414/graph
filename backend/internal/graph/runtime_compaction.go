package graph

import (
	"os"
	"regexp"
	"strconv"
	"strings"
)

type CompactionSettings struct {
	Enabled          bool `json:"enabled"`
	ReserveTokens    int  `json:"reserveTokens"`
	KeepRecentTokens int  `json:"keepRecentTokens"`
}

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

const COMPACTION_INSTRUCTIONS = "This summary is a working handoff for the next turn, not a transcript. Keep the entire summary under roughly 1500 tokens. Write only the handoff. Do not include <analysis>, <summary>, reasoning, or a chronology of the conversation. Drop resolved detail, superseded attempts and stale plans instead of preserving them. Keep only what is needed to continue: the goal, the current state, open blockers, key decisions, exact file paths and the next steps."

var (
	compactionAnalysis = regexp.MustCompile(`(?i)(?:^|\n)\s*<analysis>\s*(?:\n|$)`)
	compactionSummary  = regexp.MustCompile(`(?i)(?:^|\n)\s*<summary>\s*(?:\n|$)`)
	compactionClosed   = regexp.MustCompile(`(?i)(?:^|\n)\s*</summary>\s*$`)
	compactionNoop     = regexp.MustCompile(`^(?:Compaction failed: )?(?:Already compacted|Nothing to compact \(session too small\))$`)
)

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

func IsSummaryLeakRetry(output any) bool {
	record, ok := output.(map[string]any)
	if !ok || output == nil {
		return false
	}
	code, _ := record["retryCode"].(string)
	return code == "session_summary_leak"
}

func IsCompactionNoop(message string) bool {
	return compactionNoop.MatchString(message)
}

const COMPACTION_CONTEXT_CEILING = "GRAPH_COMPACTION_CONTEXT_CEILING"

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
