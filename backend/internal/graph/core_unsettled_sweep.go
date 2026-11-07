package graph

import "fmt"

const SettledOperationCutoff = 60 * 60 * 1000

const unsettledOperationSweepLimit = 10

const maxOpenUnsettledProblems = 20

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

const abandonedOperationSweepLimit = 50

func (runtime *TaskRuntime) AbandonClosedUnsettledOperations(now int64) int {
	runtime.ensureOpen()
	rows := kernelRows(runtime.store.Db, `SELECT o.id,o.task_id,o.dispatched_at FROM operations o
      WHERE o.state='unknown' AND o.settled_at IS NULL AND o.worker_active=0
        AND EXISTS (SELECT 1 FROM questions q
          WHERE COALESCE(q.operation_id,json_extract(q.data,'$.operationId'))=o.id AND q.status!='open')
        AND NOT EXISTS (SELECT 1 FROM questions q
          WHERE COALESCE(q.operation_id,json_extract(q.data,'$.operationId'))=o.id AND q.status='open')
      ORDER BY o.dispatched_at LIMIT ?`, abandonedOperationSweepLimit)
	abandoned := 0
	for _, row := range rows {
		id, taskId := kernelString(row["id"]), kernelString(row["task_id"])
		waited := now - kernelInt(row["dispatched_at"])
		if waited < 0 {
			waited = 0
		}
		func() {
			defer func() { _ = recover() }()
			if !runtime.store.AbandonOperation(id, now) {
				return
			}
			runtime.store.Event(taskId, "operation.abandoned", map[string]any{
				"operationId": id,
				"waitedMs":    waited,
				"reason":      "the problem reported for it is answered; the outcome stays unproven",
			})
			abandoned++
		}()
	}
	return abandoned
}

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
