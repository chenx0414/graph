package graph

import "encoding/json"

const taskInvocationTotalsDDL = `CREATE TABLE IF NOT EXISTS task_invocation_totals(
  task_id TEXT PRIMARY KEY,
  invocations INTEGER NOT NULL DEFAULT 0,
  cost_unknown INTEGER NOT NULL DEFAULT 0,
  costs TEXT NOT NULL DEFAULT '{}',
  usage_input INTEGER NOT NULL DEFAULT 0,
  usage_cache_read INTEGER NOT NULL DEFAULT 0,
  usage_cache_write INTEGER NOT NULL DEFAULT 0,
  completion_rowid INTEGER NOT NULL DEFAULT 0,
  completion_usage TEXT NOT NULL DEFAULT '',
  completion_settled INTEGER NOT NULL DEFAULT 0,
  throughput_settled INTEGER NOT NULL DEFAULT 0,
  throughput_dispatched INTEGER NOT NULL DEFAULT 0,
  throughput_usage TEXT NOT NULL DEFAULT ''
)`

type taskInvocationTotals struct {
	Invocations          int64
	CostUnknown          int64
	Costs                map[string]float64
	UsageInput           int64
	UsageCacheRead       int64
	UsageCacheWrite      int64
	CompletionRowid      int64
	CompletionUsage      string
	CompletionSettled    int64
	ThroughputSettled    int64
	ThroughputDispatched int64
	ThroughputUsage      string
}

type invocationTotalsRecord struct {
	Input         *int64 `json:"input"`
	Output        *int64 `json:"output"`
	CacheRead     *int64 `json:"cacheRead"`
	CacheWrite    *int64 `json:"cacheWrite"`
	ContextTokens *int64 `json:"contextTokens"`
	DurationMs    *int64 `json:"durationMs"`
	FirstTokenMs  *int64 `json:"firstTokenMs"`
	UploadMs      *int64 `json:"uploadMs"`
	ServerWaitMs  *int64 `json:"serverWaitMs"`
}

func parseInvocationTotalsUsage(text string) (invocationTotalsRecord, bool) {
	var record invocationTotalsRecord
	if text == "" || json.Unmarshal([]byte(text), &record) != nil {
		return record, false
	}
	return record, true
}

func (totals *taskInvocationTotals) apply(usageText, costText, purpose string, rowid, dispatched, settled int64, sign int64) {
	if totals.Costs == nil {
		totals.Costs = map[string]float64{}
	}
	if costText == "" {
		totals.CostUnknown += sign
	} else {
		var cost struct {
			Amount   *float64 `json:"amount"`
			Currency *string  `json:"currency"`
			Unknown  bool     `json:"unknown"`
		}
		if err := json.Unmarshal([]byte(costText), &cost); err != nil || cost.Unknown || cost.Amount == nil {
			totals.CostUnknown += sign
		} else {
			currency := "?"
			if cost.Currency != nil && *cost.Currency != "" {
				currency = *cost.Currency
			}
			totals.Costs[currency] += float64(sign) * *cost.Amount
			if totals.Costs[currency] == 0 {
				delete(totals.Costs, currency)
			}
		}
	}
	record, ok := parseInvocationTotalsUsage(usageText)
	if !ok {
		return
	}
	input, cacheRead, cacheWrite := int64(0), int64(0), int64(0)
	if record.Input != nil {
		input = *record.Input
	}
	if record.CacheRead != nil {
		cacheRead = *record.CacheRead
	}
	if record.CacheWrite != nil {
		cacheWrite = *record.CacheWrite
	}
	total := input + cacheRead + cacheWrite
	totals.UsageInput += sign * input
	totals.UsageCacheRead += sign * cacheRead
	totals.UsageCacheWrite += sign * cacheWrite
	if sign < 0 {
		return
	}
	if purpose == "completion" && total > 0 && rowid >= totals.CompletionRowid {
		totals.CompletionRowid = rowid
		totals.CompletionUsage = usageText
		totals.CompletionSettled = settled
	}
	if record.Output != nil && *record.Output > 0 && settled > dispatched && settled >= totals.ThroughputSettled {
		totals.ThroughputSettled = settled
		totals.ThroughputDispatched = dispatched
		totals.ThroughputUsage = usageText
	}
}

func (store *TaskStore) saveTaskInvocationTotals(taskID string, totals taskInvocationTotals) {
	costs, _ := json.Marshal(totals.Costs)
	if costs == nil {
		costs = []byte(`{}`)
	}
	kernelExec(store.DB, `INSERT INTO task_invocation_totals(
      task_id,invocations,cost_unknown,costs,usage_input,usage_cache_read,usage_cache_write,
      completion_rowid,completion_usage,completion_settled,throughput_settled,throughput_dispatched,throughput_usage
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET invocations=excluded.invocations,cost_unknown=excluded.cost_unknown,
      costs=excluded.costs,usage_input=excluded.usage_input,usage_cache_read=excluded.usage_cache_read,
      usage_cache_write=excluded.usage_cache_write,completion_rowid=excluded.completion_rowid,
      completion_usage=excluded.completion_usage,completion_settled=excluded.completion_settled,
      throughput_settled=excluded.throughput_settled,throughput_dispatched=excluded.throughput_dispatched,
      throughput_usage=excluded.throughput_usage`,
		taskID, totals.Invocations, totals.CostUnknown, string(costs), totals.UsageInput, totals.UsageCacheRead,
		totals.UsageCacheWrite, totals.CompletionRowid, totals.CompletionUsage, totals.CompletionSettled,
		totals.ThroughputSettled, totals.ThroughputDispatched, totals.ThroughputUsage)
}

func taskInvocationTotalsFromRow(row map[string]any) taskInvocationTotals {
	totals := taskInvocationTotals{
		Invocations:          kernelInt(row["invocations"]),
		CostUnknown:          kernelInt(row["cost_unknown"]),
		UsageInput:           kernelInt(row["usage_input"]),
		UsageCacheRead:       kernelInt(row["usage_cache_read"]),
		UsageCacheWrite:      kernelInt(row["usage_cache_write"]),
		CompletionRowid:      kernelInt(row["completion_rowid"]),
		CompletionUsage:      kernelString(row["completion_usage"]),
		CompletionSettled:    kernelInt(row["completion_settled"]),
		ThroughputSettled:    kernelInt(row["throughput_settled"]),
		ThroughputDispatched: kernelInt(row["throughput_dispatched"]),
		ThroughputUsage:      kernelString(row["throughput_usage"]),
	}
	totals.Costs = map[string]float64{}
	_ = json.Unmarshal([]byte(kernelString(row["costs"])), &totals.Costs)
	return totals
}

func (store *TaskStore) ensureTaskInvocationTotals(taskID string) taskInvocationTotals {
	if row := kernelRow(store.DB, "SELECT * FROM task_invocation_totals WHERE task_id=?", taskID); row != nil {
		return taskInvocationTotalsFromRow(row)
	}
	totals := taskInvocationTotals{Costs: map[string]float64{}}
	rows := kernelRows(store.DB, `SELECT i.usage AS usage,i.cost AS cost,i.purpose AS purpose,i.rowid AS rowid,
       i.dispatched_at AS dispatchedAt,i.settled_at AS settledAt
    FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE o.task_id=? ORDER BY i.rowid`, taskID)
	for _, row := range rows {
		totals.Invocations++
		totals.apply(kernelString(row["usage"]), kernelString(row["cost"]), kernelString(row["purpose"]),
			kernelInt(row["rowid"]), kernelInt(row["dispatchedAt"]), kernelInt(row["settledAt"]), 1)
	}
	store.saveTaskInvocationTotals(taskID, totals)
	return totals
}

func (store *TaskStore) addOpenInvocationToTotals(operationID string) {
	row := kernelRow(store.DB, `SELECT o.task_id AS taskId FROM operations o WHERE o.id=?`, operationID)
	if row == nil {
		return
	}
	taskID := kernelString(row["taskId"])
	totals := store.ensureTaskInvocationTotals(taskID)
	totals.Invocations++
	totals.CostUnknown++
	store.saveTaskInvocationTotals(taskID, totals)
}

func (store *TaskStore) settleInvocationTotals(invocationID string) {
	row := kernelRow(store.DB, `SELECT i.usage AS usage,i.cost AS cost,i.purpose AS purpose,i.rowid AS rowid,
       i.dispatched_at AS dispatchedAt,i.settled_at AS settledAt,o.task_id AS taskId
    FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE i.id=?`, invocationID)
	if row == nil {
		return
	}
	taskID := kernelString(row["taskId"])
	totals := store.ensureTaskInvocationTotals(taskID)
	store.saveTaskInvocationTotals(taskID, totals)
}

func taskInvocationCachedTotals(store *TaskStore, taskID string) (taskInvocationTotals, bool) {
	if taskID == "" {
		return taskInvocationTotals{}, false
	}
	row := kernelRow(store.DB, "SELECT * FROM task_invocation_totals WHERE task_id=?", taskID)
	if row == nil {
		return taskInvocationTotals{}, false
	}
	return taskInvocationTotalsFromRow(row), true
}
