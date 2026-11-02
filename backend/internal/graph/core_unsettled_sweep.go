package graph

import "fmt"

// SettledOperationCutoff is how long a dispatched operation may stay without a
// settled outcome before the harness hands it to the main Agent.
//
// The product's promise is that an unproven outcome stays parked for review, and
// that promise failed silently: measured 2026-11-01, 98 operations sat in
// "unknown", the oldest 44 days old, with no result, no usage and no question
// anywhere - nobody had ever been told. Parked is fine; invisible is not.
const SettledOperationCutoff = 60 * 60 * 1000

// unsettledOperationSweepLimit bounds one pass so a large backlog becomes a few
// problems at a time instead of a storm in the inbox.
const unsettledOperationSweepLimit = 10

// maxOpenUnsettledProblems bounds the inbox itself, not just one pass: a backlog
// of 98 stuck operations would otherwise turn into 98 open problems within ten
// minutes. The rest surface as these are answered.
const maxOpenUnsettledProblems = 20

// SweepUnsettledOperations gives every operation whose outcome was never settled
// to the main Agent, one problem per operation.
//
// It does not retry anything and does not settle anything: the decision belongs
// to whoever reads the problem. An operation already named by a question is left
// alone, so the same stuck turn is not reported on every pass, and a
// conversation that was archived keeps its history without raising new
// problems.
func (runtime *TaskRuntime) SweepUnsettledOperations(now int64) int {
	runtime.ensureOpen()
	open := int(kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM questions WHERE kind='recovery' AND status='open'")["count"]))
	if open >= maxOpenUnsettledProblems {
		return 0
	}
	limit := unsettledOperationSweepLimit
	if remaining := maxOpenUnsettledProblems - open; remaining < limit {
		limit = remaining
	}
	rows := kernelRows(runtime.store.Db, `SELECT o.id,o.task_id,o.node_id,o.dispatched_at FROM operations o
      JOIN tasks t ON t.id=o.task_id
      LEFT JOIN conversations c ON c.id=t.conversation_id
      WHERE o.state='unknown' AND o.settled_at IS NULL
        AND o.dispatched_at IS NOT NULL AND o.dispatched_at<=?
        AND (c.id IS NULL OR c.archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM questions q WHERE json_extract(q.data,'$.operationId')=o.id)
      ORDER BY o.dispatched_at LIMIT ?`, now-int64(SettledOperationCutoff), limit)
	raised := 0
	for _, row := range rows {
		waited := now - kernelInt(row["dispatched_at"])
		if waited < 0 {
			waited = 0
		}
		taskId := kernelString(row["task_id"])
		operationId := kernelString(row["id"])
		pinned := operationId
		if len(pinned) > 8 {
			pinned = pinned[:8]
		}
		// Only what this problem actually offers: retry. Promising "abandon" here
		// would repeat the mistake of the escalation card - copy that names an
		// action the product does not have.
		prompt := fmt.Sprintf("这一轮（操作 %s）在 %s 前派发，但结果从未落定：没有回复、没有用量、也没有结论。"+
			"它不会自己重试，也不会被静默丢弃——你可以重试这一轮（会再花一次模型调用），或者先放着。",
			pinned, unsettledWaitText(waited))
		InsertQuestion(runtime.store, QuestionInput{
			TaskId: taskId,
			NodeId: kernelString(row["node_id"]),
			Kind:   "recovery",
			Data: map[string]any{
				"operationId":  operationId,
				"dispatchedAt": kernelInt(row["dispatched_at"]),
				"waitedMs":     waited,
				"prompt":       prompt,
			},
		})
		runtime.store.Event(taskId, "operation.unsettled_surfaced", map[string]any{
			"operationId": operationId,
			"waitedMs":    waited,
		})
		raised++
	}
	return raised
}

// unsettledWaitText says how long ago in words a person reads without arithmetic.
func unsettledWaitText(ms int64) string {
	minutes := ms / 60000
	if minutes < 60 {
		return fmt.Sprintf("%d 分钟", minutes)
	}
	hours := minutes / 60
	if hours < 48 {
		return fmt.Sprintf("%d 小时", hours)
	}
	return fmt.Sprintf("%d 天", hours/24)
}
