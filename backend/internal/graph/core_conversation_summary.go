package graph

import (
	"regexp"

	"encoding/json"
)

// NewConversationId mints the id of one new conversation.
func NewConversationId() string {
	return newUUID()
}

// ConversationMasterUsage rebuilds the master Agent's context and cache counters from the
// persisted invocation ledger. Invocations are joined through their operation's task, not
// through an instance id, so a replaced or rebound master instance can never drop the
// numbers back to zero: the records still belong to this conversation. `contextTokens` is
// the newest completed turn's `input+cacheRead+cacheWrite`; a completion whose usage is
// missing or adds up to zero (a turn that never really ran) is not a completed turn and
// must not overwrite a known value. The cache aggregate uses the same denominator over every
// recorded turn. The same newest completed turn carries `cacheReadTokens` - the prefix the
// provider served from its cache - and `cacheUsedAt`, the millisecond it settled. Providers
// report hit and miss counts, never an expiry instant, so the age of that request is the only
// cache-freshness fact the console can honestly print.
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
	for _, row := range rows {
		text := kernelString(row["usage"])
		if text == "" {
			continue
		}
		usage := struct {
			Input      *int64 `json:"input"`
			CacheRead  *int64 `json:"cacheRead"`
			CacheWrite *int64 `json:"cacheWrite"`
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
			contextTokens = &value
			// A provider call still inside an open operation has no settled time yet.
			// The cache pair then keeps describing the last request that really
			// finished, so the footer does not drop the age in the middle of a turn and
			// the tokens and the time always belong to the same request.
			if settled := kernelInt(row["settledAt"]); settled > 0 {
				read := cacheRead
				cacheReadTokens = &read
				usedAt := settled
				cacheUsedAt = &usedAt
			}
		}
	}
	return ConversationMasterUsageView{CachedInput: cachedInput, CacheInput: cacheInput, ContextTokens: contextTokens, CacheReadTokens: cacheReadTokens, CacheUsedAt: cacheUsedAt}
}

var (
	conversationInterruptedPattern  = regexp.MustCompile(`(?i)打断|中断|interrupted`)
	conversationTruncatedPattern    = regexp.MustCompile(`(?i)unterminated string|unexpected end of (json|input)|unexpected token|output token limit|truncat`)
	conversationUnknownUsagePattern = regexp.MustCompile(`(?i)unknown usage`)
)
