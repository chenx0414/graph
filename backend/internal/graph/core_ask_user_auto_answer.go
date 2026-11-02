package graph

import "fmt"

// AskUserAutoAnswerMs is how long an ask_user question may sit unanswered
// before the harness takes the asker's recommended option.
//
// The person is often away; a question that blocks the work for ever is worse
// than one that proceeds the way the asker said it would. Five minutes is short
// on purpose - the answer is a decision already written down, and an asker who
// needs a human for something can leave the recommendation out.
const AskUserAutoAnswerMs = 5 * 60 * 1000

// SweepAutoAnswerQuestions answers the ask_user questions nobody came back to.
//
// Only agent questions with options take part: a permission grant, a budget or a
// human acceptance is a gate a machine must not pass on the person's behalf, and
// a question without options has no recommendation to take. The conversation
// says what happened, so a person coming back sees the choice made in their name
// instead of discovering it from the work.
func (runtime *TaskRuntime) SweepAutoAnswerQuestions(now int64) int {
	runtime.ensureOpen()
	rows := kernelRows(runtime.store.Db, `SELECT q.id,q.task_id,q.data FROM questions q
      JOIN tasks t ON t.id=q.task_id
      LEFT JOIN conversations c ON c.id=t.conversation_id
      WHERE q.status='open' AND q.owner='user' AND q.kind='waiting'
        AND q.asked_at IS NOT NULL AND q.asked_at<=?
        AND (c.id IS NULL OR c.archived_at IS NULL)
      ORDER BY q.asked_at LIMIT 20`, now-int64(AskUserAutoAnswerMs))
	answered := 0
	for _, row := range rows {
		questionId := kernelString(row["id"])
		taskId := kernelString(row["task_id"])
		record := questionParseRecord(kernelString(row["data"]))
		if mapString(record, "requestType") != "user_decision" || record["autoAnsweredAt"] != nil || record["multiple"] == true {
			continue
		}
		options := questionOptions(record["options"])
		if len(options) == 0 {
			continue
		}
		choice := mapString(record, "recommended")
		if !containsString(options, choice) {
			choice = options[0]
		}
		func() {
			defer func() { _ = recover() }()
			runtime.User().Task(taskId).Answer(questionId, Answer{Type: "respond", Value: choice}, "ask-user-auto-"+questionId)
			name := mapString(record, "recommended")
			if name == "" {
				name = "列表第一项"
			}
			kernelExec(runtime.store.Db, `UPDATE questions SET data=json_set(COALESCE(data,'{}'),'$.autoAnsweredAt',?)
          WHERE id=?`, now, questionId)
			if conversation := ConversationForTask(runtime.store, taskId); conversation != nil {
				AppendMessage(runtime.store, MessageInput{
					ConversationID: conversation.Id,
					Role:           MessageRoleSystem,
					Kind:           "question",
					Text:           fmt.Sprintf("5 分钟没有回答，已按推荐选项「%s」继续（推荐来自%s）；你随时可以接着说别的。", choice, name),
					State:          MessageStateDone,
				})
			}
			answered++
		}()
	}
	return answered
}

// questionOptions reads the option list of a stored question.
func questionOptions(raw any) []string {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := []string{}
	for _, item := range list {
		text, _ := item.(string)
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}
