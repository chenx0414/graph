package graph

import (
	"regexp"

	"encoding/json"
)

func NewConversationId() string {
	return newUUID()
}

func ConversationMasterUsage(store *TaskStore, conversationId string) ConversationMasterUsageView {
	masterTasks := kernelRows(store.Db, `SELECT DISTINCT n.task_id AS taskId FROM nodes n
    JOIN tasks t ON t.id=n.task_id
    WHERE t.conversation_id=? AND json_extract(n.spec,'$.role')='master'`, conversationId)
	view := ConversationMasterUsageView{}
	var completion taskInvocationTotals
	var throughput taskInvocationTotals
	for _, row := range masterTasks {
		totals := store.ensureTaskInvocationTotals(kernelString(row["taskId"]))
		view.CachedInput += totals.UsageCacheRead
		view.CacheInput += totals.UsageInput + totals.UsageCacheRead + totals.UsageCacheWrite
		if totals.CompletionRowid >= completion.CompletionRowid {
			completion = totals
		}
		if totals.ThroughputSettled >= throughput.ThroughputSettled {
			throughput = totals
		}
	}
	if completion.CompletionRowid > 0 {
		record, ok := parseInvocationTotalsUsage(completion.CompletionUsage)
		if ok {
			total := int64(0)
			if record.Input != nil {
				total += *record.Input
			}
			if record.CacheRead != nil {
				total += *record.CacheRead
			}
			if record.CacheWrite != nil {
				total += *record.CacheWrite
			}
			value := total
			if record.ContextTokens != nil && *record.ContextTokens > 0 {
				value = *record.ContextTokens
			}
			view.ContextTokens = &value
			if completion.CompletionSettled > 0 {
				read := int64(0)
				if record.CacheRead != nil {
					read = *record.CacheRead
				}
				usedAt := completion.CompletionSettled
				rate := 0.0
				if total > 0 {
					rate = float64(read) / float64(total)
				}
				view.CacheReadTokens = &read
				view.CacheUsedAt = &usedAt
				view.RequestCacheHitRate = &rate
			}
		}
	}
	if throughput.ThroughputSettled > 0 {
		record, ok := parseInvocationTotalsUsage(throughput.ThroughputUsage)
		if ok && record.Output != nil && *record.Output > 0 {
			latency := throughput.ThroughputSettled - throughput.ThroughputDispatched
			decode := latency
			if record.DurationMs != nil && *record.DurationMs > 0 {
				decode = *record.DurationMs
			}
			output := *record.Output
			facts := throughputFacts{
				FirstTokenMs: record.FirstTokenMs, UploadMs: record.UploadMs, ServerWaitMs: record.ServerWaitMs,
			}
			if decode > 0 {
				rate := float64(output) / (float64(decode) / 1000)
				facts.OutputTokens = &output
				facts.LatencyMs = &latency
				facts.TokensPerSecond = &rate
			}
			view.OutputTokens = facts.OutputTokens
			view.LatencyMs = facts.LatencyMs
			view.TokensPerSecond = facts.TokensPerSecond
			view.FirstTokenMs = facts.FirstTokenMs
			view.UploadMs = facts.UploadMs
			view.ServerWaitMs = facts.ServerWaitMs
		}
	}
	return view
}

var (
	conversationInterruptedPattern  = regexp.MustCompile(`(?i)打断|中断|interrupted`)
	conversationTruncatedPattern    = regexp.MustCompile(`(?i)unterminated string|unexpected end of (json|input)|unexpected token|output token limit|truncat`)
	conversationUnknownUsagePattern = regexp.MustCompile(`(?i)unknown usage`)
)

type throughputFacts struct {
	OutputTokens    *int64
	LatencyMs       *int64
	TokensPerSecond *float64
	FirstTokenMs    *int64
	UploadMs        *int64
	ServerWaitMs    *int64
}

func masterThroughput(store *TaskStore, conversationId string) (*int64, *int64, *float64, *int64) {
	facts := masterThroughputFacts(store, conversationId)
	return facts.OutputTokens, facts.LatencyMs, facts.TokensPerSecond, facts.FirstTokenMs
}

func masterThroughputFacts(store *TaskStore, conversationId string) throughputFacts {
	row := kernelRow(store.Db, `SELECT i.usage AS usage, i.dispatched_at AS createdAt, i.settled_at AS settledAt
    FROM invocations i
    JOIN operations o ON o.id=i.operation_id
    JOIN tasks t ON t.id=o.task_id
    WHERE t.conversation_id=? AND i.settled_at > i.dispatched_at
      AND json_extract(i.usage,'$.output') > 0
      AND EXISTS (SELECT 1 FROM nodes n WHERE n.task_id=o.task_id AND n.id=o.node_id AND json_extract(n.spec,'$.role')='master')
    ORDER BY i.settled_at DESC LIMIT 1`, conversationId)
	return throughputFactsOf(row)
}

func throughputFactsOf(row map[string]any) throughputFacts {
	if row == nil {
		return throughputFacts{}
	}
	usage := struct {
		Output       *int64 `json:"output"`
		DurationMs   *int64 `json:"durationMs"`
		FirstTokenMs *int64 `json:"firstTokenMs"`
		UploadMs     *int64 `json:"uploadMs"`
		ServerWaitMs *int64 `json:"serverWaitMs"`
	}{}
	if err := json.Unmarshal([]byte(kernelString(row["usage"])), &usage); err != nil {
		return throughputFacts{}
	}
	latency := kernelInt(row["settledAt"]) - kernelInt(row["createdAt"])
	decode := latency
	if usage.DurationMs != nil && *usage.DurationMs > 0 {
		decode = *usage.DurationMs
	}
	if usage.Output == nil || *usage.Output <= 0 || decode <= 0 {
		return throughputFacts{FirstTokenMs: usage.FirstTokenMs, UploadMs: usage.UploadMs, ServerWaitMs: usage.ServerWaitMs}
	}
	output := *usage.Output
	rate := float64(output) / (float64(decode) / 1000)
	return throughputFacts{
		OutputTokens: &output, LatencyMs: &latency, TokensPerSecond: &rate,
		FirstTokenMs: usage.FirstTokenMs, UploadMs: usage.UploadMs, ServerWaitMs: usage.ServerWaitMs,
	}
}
