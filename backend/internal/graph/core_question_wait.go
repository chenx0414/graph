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

// QuestionWaitFacts is how long one question has waited, in the shape the
// console reads. asked_at is 0 for rows written before the column existed; the
// wait is then reported as unknown instead of invented.
func QuestionWaitFacts(askedAt, now int64) map[string]any {
	facts := map[string]any{"askedAt": nil, "waitedMs": nil, "overdueAfterMs": QuestionOverdueMs, "overdue": false}
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
	return facts
}

// AddQuestionWaitFacts puts the wait on a question payload the console reads.
func AddQuestionWaitFacts(payload map[string]any, askedAt any, now int64) map[string]any {
	for key, value := range QuestionWaitFacts(kernelInt(askedAt), now) {
		payload[key] = value
	}
	return payload
}
