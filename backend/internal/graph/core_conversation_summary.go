package graph

import (
	"regexp"

	"encoding/json"
)

func NewConversationId() string {
	return newUUID()
}

func ConversationMasterUsage(store *TaskStore, conversationId string) ConversationMasterUsageView {
	rows := kernelRows(store.Db, `SELECT i.usage AS usage,i.purpose AS purpose,o.settled_at AS settledAt
    FROM invocations i
    JOIN operations o ON o.id=i.operation_id
    JOIN tasks t ON t.id=o.task_id
    WHERE t.conversation_id=?
      AND EXISTS (SELECT 1 FROM nodes n WHERE n.task_id=o.task_id AND n.id=o.node_id AND json_extract(n.spec,'$.role')='master')
    ORDER BY i.rowid`, conversationId)
	var cacheInput int64
	var cachedInput int64
	var contextTokens *int64
	var cacheReadTokens *int64
	var cacheUsedAt *int64
	var requestCacheHitRate *float64
	for _, row := range rows {
		text := kernelString(row["usage"])
		if text == "" {
			continue
		}
		usage := struct {
			Input         *int64 `json:"input"`
			CacheRead     *int64 `json:"cacheRead"`
			CacheWrite    *int64 `json:"cacheWrite"`
			ContextTokens *int64 `json:"contextTokens"`
		}{}
		if err := json.Unmarshal([]byte(text), &usage); err != nil {
			panic(err)
		}
		input := int64(0)
		if usage.Input != nil {
			input = *usage.Input
		}
		cacheRead := int64(0)
		if usage.CacheRead != nil {
			cacheRead = *usage.CacheRead
		}
		cacheWrite := int64(0)
		if usage.CacheWrite != nil {
			cacheWrite = *usage.CacheWrite
		}
		total := input + cacheRead + cacheWrite
		cacheInput += total
		cachedInput += cacheRead
		if kernelString(row["purpose"]) == "completion" && total > 0 {
			value := total
			if usage.ContextTokens != nil && *usage.ContextTokens > 0 {
				value = *usage.ContextTokens
			}
			contextTokens = &value
			requestRate := 0.0
			if total > 0 {
				requestRate = float64(cacheRead) / float64(total)
			}
			requestRateCopy := requestRate
			if settled := kernelInt(row["settledAt"]); settled > 0 {
				read := cacheRead
				cacheReadTokens = &read
				usedAt := settled
				cacheUsedAt = &usedAt
				requestCacheHitRate = &requestRateCopy
			}
		}
	}
	outputTokens, latencyMs, tokensPerSecond := masterThroughput(store, conversationId)
	return ConversationMasterUsageView{
		CachedInput: cachedInput, CacheInput: cacheInput, ContextTokens: contextTokens,
		RequestCacheHitRate: requestCacheHitRate,
		CacheReadTokens: cacheReadTokens, CacheUsedAt: cacheUsedAt,
		OutputTokens: outputTokens, LatencyMs: latencyMs, TokensPerSecond: tokensPerSecond,
	}
}

var (
	conversationInterruptedPattern  = regexp.MustCompile(`(?i)打断|中断|interrupted`)
	conversationTruncatedPattern    = regexp.MustCompile(`(?i)unterminated string|unexpected end of (json|input)|unexpected token|output token limit|truncat`)
	conversationUnknownUsagePattern = regexp.MustCompile(`(?i)unknown usage`)
)

func masterThroughput(store *TaskStore, conversationId string) (*int64, *int64, *float64) {
	row := kernelRow(store.Db, `SELECT i.usage AS usage, i.dispatched_at AS createdAt, i.settled_at AS settledAt
    FROM invocations i
    JOIN operations o ON o.id=i.operation_id
    JOIN tasks t ON t.id=o.task_id
    WHERE t.conversation_id=? AND i.settled_at > i.dispatched_at
      AND json_extract(i.usage,'$.output') > 0
      AND EXISTS (SELECT 1 FROM nodes n WHERE n.task_id=o.task_id AND n.id=o.node_id AND json_extract(n.spec,'$.role')='master')
    ORDER BY i.settled_at DESC LIMIT 1`, conversationId)
	return throughputOf(row)
}

func throughputOf(row map[string]any) (*int64, *int64, *float64) {
	if row == nil {
		return nil, nil, nil
	}
	usage := struct {
		Output     *int64 `json:"output"`
		DurationMs *int64 `json:"durationMs"`
	}{}
	if err := json.Unmarshal([]byte(kernelString(row["usage"])), &usage); err != nil {
		return nil, nil, nil
	}
	latency := kernelInt(row["settledAt"]) - kernelInt(row["createdAt"])
	decode := latency
	if usage.DurationMs != nil && *usage.DurationMs > 0 {
		decode = *usage.DurationMs
	}
	if usage.Output == nil || *usage.Output <= 0 || decode <= 0 {
		return nil, nil, nil
	}
	output := *usage.Output
	rate := float64(output) / (float64(decode) / 1000)
	return &output, &latency, &rate
}
