package graph

import (
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

type CompactionSettings struct {
	Enabled          bool `json:"enabled"`
	ReserveTokens    int  `json:"reserveTokens"`
	KeepRecentTokens int  `json:"keepRecentTokens"`
}

func compactionSettingsFor(entry struct {
	ContextWindow int
	MaxTokens     int
}) CompactionSettings {
	reserve, keep := pigkernel.CompactionPolicyFor(entry.ContextWindow)
	return CompactionSettings{Enabled: true, ReserveTokens: reserve, KeepRecentTokens: keep}
}

const COMPACTION_INSTRUCTIONS = "This summary is a working handoff for the next turn, not a transcript. Keep the entire summary under roughly 1500 tokens. Write only the handoff. Do not include <analysis>, <summary>, reasoning, or a chronology of the conversation. Drop resolved detail, superseded attempts and stale plans instead of preserving them. Keep only what is needed to continue: the goal, the current state, open blockers, key decisions, exact file paths and the next steps. End with one sentence saying the earlier conversation stays in the durable transcript and can be searched with the history_search tool, by keyword or as one entry by id."

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

func IsUnfinishedToolCalls(output any) bool {
	record, ok := output.(map[string]any)
	if !ok || output == nil {
		return false
	}
	code, _ := record["retryCode"].(string)
	return code == "tool_calls_unfinished"
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

const historyToolNameGraph = "history_search"

func compactionPointer(conversationId string) string {
	return "你正在继续会话 " + conversationId + "。一边进行一边从中检索关键上下文。"
}
