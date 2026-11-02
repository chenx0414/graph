package graph

// How long a question may wait for the person who has to answer it before the
// console stops calling it only "open".
//
// The deadline answers nothing: a question only a person can answer stays open
// until that person answers, and no timer releases its lane. What the deadline
// changes is what the wait looks like. Measured 2026-11-01: an unanswered
// question and a running agent were indistinguishable in the console, so a
// conversation that had stood still for hours still read as "in progress".
const QuestionOverdueMs = 15 * 60 * 1000

// How long a question may wait before it stops occupying the "in progress"
// shape and is reported as suspended.
//
// Suspended is still open. Nothing answers it, nothing drops it, and the node
// behind it stays exactly as blocked as before: the only change is the word the
// product uses for it. A conversation that has waited this long is not being
// worked on - it is waiting for a person - and every surface has to say so
// instead of leaving "blocked by a runtime problem" and "blocked by you" under
// the same label.
const QuestionSuspendedMs = 45 * 60 * 1000

// QuestionWaitFacts is how long one question has waited, in the shape the
// console reads. asked_at is 0 for rows written before the column existed; the
// wait is then reported as unknown instead of invented.
func QuestionWaitFacts(askedAt, now int64) map[string]any {
	facts := map[string]any{
		"askedAt": nil, "waitedMs": nil,
		"overdueAfterMs": QuestionOverdueMs, "overdue": false,
		"suspendedAfterMs": QuestionSuspendedMs, "suspended": false,
	}
	if askedAt <= 0 {
		return facts
	}
	waited := now - askedAt
	if waited < 0 {
		waited = 0
	}
	facts["askedAt"] = askedAt
	facts["waitedMs"] = waited
	facts["overdue"] = waited >= int64(QuestionOverdueMs)
	facts["suspended"] = waited >= int64(QuestionSuspendedMs)
	return facts
}

// AddQuestionWaitFacts puts the wait on a question payload the console reads.
//
// A question the harness will answer itself carries the deadline that actually
// applies to it, not the generic ones: measured 2026-11-02, a decision question
// whose card said "超过 45 分钟无人回答，不再算进行中" was answered by the
// harness after five minutes, so the card promised a state the product could
// never reach and never mentioned the choice being made in the person's name.
func AddQuestionWaitFacts(payload map[string]any, askedAt any, now int64) map[string]any {
	asked := kernelInt(askedAt)
	facts := QuestionWaitFacts(asked, now)
	record, _ := payload["data"].(map[string]any)
	if choice, ok := questionAutoAnswerChoice(record); ok {
		// Overdue and suspended describe a question that nothing answers. This one
		// is answered, so those two thresholds are unreachable and say nothing.
		facts["overdue"], facts["suspended"] = false, false
		facts["autoAnswerAfterMs"] = AskUserAutoAnswerMs
		facts["autoAnswerChoice"] = choice
		if asked > 0 {
			at := asked + int64(AskUserAutoAnswerMs)
			remaining := at - now
			if remaining < 0 {
				remaining = 0
			}
			facts["autoAnswerAt"], facts["autoAnswerRemainingMs"] = at, remaining
		} else {
			facts["autoAnswerAt"], facts["autoAnswerRemainingMs"] = nil, nil
		}
	}
	for key, value := range facts {
		payload[key] = value
	}
	return payload
}

// QuestionWaitStatus is the status a task or conversation reports while a
// question of its own has outlived QuestionSuspendedMs: "awaiting_user". Every
// other blocking reason keeps the existing "blocked", so the two can no longer
// be read as the same thing.
const QuestionWaitStatus = "awaiting_user"

// StatusForQuestions picks the blocking status for a set of open user questions.
func StatusForQuestions(openQuestions []map[string]any, fallback string) string {
	if len(openQuestions) == 0 {
		return fallback
	}
	for _, question := range openQuestions {
		if question["suspended"] == true {
			return QuestionWaitStatus
		}
	}
	return "blocked"
}
