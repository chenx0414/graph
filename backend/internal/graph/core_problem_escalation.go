package graph

import "fmt"

// How long a problem owned by the main Agent may wait before the harness hands
// it to the person.
//
// The product deliberately does not retry a failure nobody asked about: an
// automatic retry spends model calls the failure did not earn. That rule is
// right, but on its own it means a problem can sit in main's own list for ever -
// measured 2026-11-01, three execution failures had been parked since the
// morning with nothing but "owner: main" to distinguish them from work in
// progress. Handing them to the person after a deadline keeps the no-retry rule
// and removes the silence: the decision becomes visible, and answering it is
// still the only thing that moves the task.
const ProblemUnattendedMs = 30 * 60 * 1000

// problemEscalationPrompt is what the person reads when a problem reaches them
// without anybody having acted on it. It states the wait and who decides. The
// action itself is the card's, not this text's: a retry re-runs the failed turn
// (measured 2026-11-01, answering retry still did not re-run it; that is fixed)
// and costs another model call, which is why the card says so next to the button
// instead of pretending the retry is free.
func problemEscalationPrompt(kind string, minutes int64) string {
	return fmt.Sprintf(
		"这个问题（%s）已经等了 %d 分钟，没有人处理。它需要有人决定怎么继续：先看详情，再选下一步。",
		kind, minutes)
}

// SweepUnattendedProblems hands every main-owned problem that outlived
// ProblemUnattendedMs to the next actor: a routed question moves one stage up
// (project → global → user), and an unrouted one goes straight to the person.
// It never retries anything, and one unreadable row does not stop the sweep.
func (runtime *TaskRuntime) SweepUnattendedProblems(now int64) int {
	runtime.ensureOpen()
	rows := kernelRows(runtime.store.Db, `SELECT id,task_id,node_id,kind,route_stage,asked_at FROM questions
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
				// Re-owning, not replacing: the question keeps its kind, its label and
				// the answers it already accepts. A new waiting question would have
				// thrown those away and left the person with a free-text box.
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
