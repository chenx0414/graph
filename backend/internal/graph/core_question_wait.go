package graph

const QuestionOverdueMs = 15 * 60 * 1000

const QuestionSuspendedMs = 45 * 60 * 1000

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

func AddQuestionWaitFacts(payload map[string]any, askedAt any, now int64) map[string]any {
	asked := kernelInt(askedAt)
	facts := QuestionWaitFacts(asked, now)
	for key, value := range facts {
		payload[key] = value
	}
	return payload
}

const QuestionWaitStatus = "awaiting_user"

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
