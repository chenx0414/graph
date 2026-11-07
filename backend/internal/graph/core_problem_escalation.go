package graph

import "fmt"

const ProblemUnattendedMs = 30 * 60 * 1000

func problemEscalationPrompt(kind string, minutes int64) string {
	return fmt.Sprintf(
		"这个问题（%s）已经等了 %d 分钟，没有人处理。它需要有人决定怎么继续：先看详情，再选下一步。",
		kind, minutes)
}

func (runtime *TaskRuntime) SweepUnattendedProblems(now int64) int {
	runtime.ensureOpen()
	rows := kernelRows(runtime.store.Db, `SELECT id,task_id,node_id,kind,data,route_stage,asked_at FROM questions
 WHERE status='open' AND owner='main' AND asked_at IS NOT NULL AND asked_at<=?
 ORDER BY rowid`, now-int64(ProblemUnattendedMs))
	escalated := 0
	for _, row := range rows {
		kind := kernelString(row["kind"])
		if !questionPolicy(kind).Escalate {
			continue
		}
		askedAt := kernelInt(row["asked_at"])
		waited := now - askedAt
		if waited < 0 {
			waited = 0
		}
		prompt := problemEscalationPrompt(kind, waited/60000)
		taskID, questionID := kernelString(row["task_id"]), kernelString(row["id"])
		stage := ""
		if row["route_stage"] != nil {
			stage = kernelString(row["route_stage"])
		}
		func() {
			defer func() { _ = recover() }()
			switch stage {
			case "project":
				runtime.escalateQuestionToGlobal(row, prompt)
			case "global":
				runtime.escalateRoutedQuestion(row, prompt)
			default:
				if conversation := ConversationForTask(runtime.store, taskID); conversation != nil &&
					conversation.Role == ConversationProject && conversation.AnchorTaskId == taskID {
					if kernelRow(runtime.store.Db, "SELECT anchor_task_id FROM conversations WHERE role='global' AND archived_at IS NULL") != nil {
						runtime.escalateQuestionToGlobal(row, prompt)
						break
					}
				}
				runtime.store.EscalateQuestionOwnership(questionID, now, kind, waited, prompt)
				runtime.store.Event(taskID, "problem.escalated.unattended", map[string]any{
					"questionId": questionID,
					"kind":       kind,
					"waitedMs":   waited,
				})
			}
			escalated++
		}()
	}
	return escalated
}
