package graph

import (
	"encoding/json"
)

func (l *OperationLifecycle) Block(taskId, nodeId, kind string, data Json, operationId *string) string {
	return l.transaction(func(tx *TaskStore) any {
		l := l.scoped(tx)
		node := l.nodeRow(taskId, nodeId)
		l.store.SetNodeBlocked(taskId, nodeId)
		l.store.BlockActivation(kernelString(node["activation_id"]))
		var autoAnswer *QuestionAutoAnswer
		if operationId != nil && kind == "permission" {
			operation := l.Get(*operationId)
			grant := ""
			if record, ok := jsonRecord(data); ok {
				if value, ok := record["grant"].(string); ok {
					grant = value
				}
			}
			if operation != nil && grant != "" {
				autoAnswer = &QuestionAutoAnswer{
					Answer: Answer{Type: "grant", Grant: grant},
					Resume: boolPtr(true),
				}
			}
		}
		input := QuestionInput{TaskId: taskId, NodeId: nodeId, Kind: kind, Data: data}
		if operationId != nil {
			input.OperationId = operationId
		}
		if autoAnswer != nil {
			input.AutoAnswer = autoAnswer
		}
		question := InsertQuestion(l.store, input)
		return question.Id
	}).(string)
}

func (l *OperationLifecycle) Answer(taskId, questionId string, answer Answer, models func() []ModelEntry) {
	l.transaction(func(tx *TaskStore) any {
		l := l.scoped(tx)
		question := kernelRow(l.store.Db, "SELECT * FROM questions WHERE id=? AND task_id=?", questionId, taskId)
		if question == nil || kernelString(question["status"]) != "open" {
			Raise("invalid_question", "No open question in this task")
		}
		kind := kernelString(question["kind"])
		nodeId := kernelString(question["node_id"])
		AssertQuestionAnswer(kind, answer)
		if answer.Type == "wait" {
			l.rearmQuestion(taskId, questionId)
			return nil
		}
		if kind == "unknown_usage" && (answer.Type == "usage" || answer.Type == "reconcile_usage") {
			operationId := kernelString(question["operation_id"])
			l.answerUnknownUsage(operationId, answer, models)
		} else if kind == "permission" && answer.Type == "grant" {
			var data map[string]any
			if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
				panic(err)
			}
			grant, _ := data["grant"].(string)
			if answer.Grant != grant {
				Raise("invalid_answer", "Grant must match the requested capability")
			}
			l.store.GrantTaskCapability(taskId, answer.Grant)
		} else if kind == "system_change" && answer.Type == "respond" {
			decision := ""
			if record, ok := jsonRecord(answer.Value); ok {
				if value, ok := record["decision"].(string); ok {
					decision = value
				}
			}
			if decision != "approved" && decision != "rejected" {
				Raise("invalid_answer", "A system change must be approved or rejected")
			}
		} else if kind == "human_check" && answer.Type == "reject" {
			var data map[string]any
			if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
				panic(err)
			}
			rejected := any(nil)
			if value, ok := data["prompt"]; ok {
				rejected = value
			}
			InsertQuestion(l.store, QuestionInput{
				TaskId: taskId,
				NodeId: nodeId,
				Kind:   "rework",
				Data: map[string]any{
					"prompt":   "A human acceptance check was rejected and must be reworked",
					"reason":   answer.Reason,
					"rejected": rejected,
				},
			})
			l.store.Event(taskId, "human.rejected", map[string]any{"questionId": questionId, "nodeId": nodeId, "reason": answer.Reason})
		}
		if kind == "human_check" && answer.Type == "acknowledge" {
			l.store.Event(taskId, "human.accepted", map[string]any{"questionId": questionId, "nodeId": nodeId})
		}
		if answer.Type == "retry" {
			l.releaseFailedTurnMessages(question)
		}
		l.store.ResolveQuestion(questionId, answer)
		CloseUserWait(l.store, taskId, nodeId)
		WakeForAnswer(l.store, taskId, map[string]any{
			"questionId": questionId,
			"nodeId":     nodeId,
			"kind":       kind,
			"answer":     answer,
		})
		if kernelRow(l.store.Db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_revisions'") != nil &&
			kernelRow(l.store.Db, "SELECT 1 FROM kernel_revisions WHERE task_id=? LIMIT 1", taskId) != nil {
			open := kernelRow(l.store.Db, "SELECT 1 FROM questions WHERE task_id=? AND status='open' LIMIT 1", taskId)
			if open == nil {
				l.store.CompleteBlockedTask(taskId)
			}
			return nil
		}
		if kernelRow(l.store.Db, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'", taskId, nodeId) == nil {
			if kernelRow(l.store.Db, "SELECT id FROM nodes WHERE task_id=? AND id=?", taskId, nodeId) == nil {
				return nil
			}
			current := kernelRow(l.store.Db, `SELECT o.state,o.result
          FROM operations o JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
          WHERE o.task_id=? AND o.node_id=? AND o.activation_id=n.activation_id
          ORDER BY o.rowid DESC LIMIT 1`, taskId, nodeId)
			completed := false
			if kernelString(current["state"]) == "succeeded" && current["result"] != nil {
				var result OperationResult
				if err := json.Unmarshal([]byte(kernelString(current["result"])), &result); err != nil {
					panic(err)
				}
				completed = result.Outcome == "completed"
			}
			specRow := kernelRow(l.store.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
			var spec NodeSpec
			if err := json.Unmarshal([]byte(kernelString(specRow["spec"])), &spec); err != nil {
				panic(err)
			}
			conversation := ConversationForTask(l.store, taskId)
			if spec.Role == nil || *spec.Role != "master" {
				conversation = nil
			}
			queued := 0
			if conversation != nil {
				queued = len(PendingMessages(l.store, conversation.Id, 1))
			}
			rejected := kind == "human_check" && answer.Type == "reject"
			next := "pending"
			if rejected {
				next = "blocked"
			} else if kind != "system_change" && completed && queued == 0 {
				next = "succeeded"
			}
			l.store.SetNodeStatus(taskId, nodeId, next)
		}
		if kind == "recovery" && answer.Type == "acknowledge" {
			l.store.SetNodeBlocked(taskId, nodeId)
		}
		return nil
	})
}

func (l *OperationLifecycle) rearmQuestion(taskId, questionId string) {
	l.store.RearmQuestion(taskId, questionId)
	l.store.Event(taskId, "problem.kept_waiting", map[string]any{"questionId": questionId})
}

func (l *OperationLifecycle) releaseFailedTurnMessages(question map[string]any) {
	operationId := kernelString(question["operation_id"])
	if operationId == "" || questionPolicy(kernelString(question["kind"])).Owner != QuestionOwnerMain {
		return
	}
	latest := kernelRow(l.store.Db, "SELECT id FROM operations WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1",
		kernelString(question["task_id"]), kernelString(question["node_id"]))
	if latest == nil || kernelString(latest["id"]) != operationId {
		return
	}
	l.store.ReleaseAnswers(operationId)
	released := []string{}
	for _, row := range MessagesForOperation(l.store, operationId) {
		if row.Role == string(MessageRoleUser) && row.State == string(MessageStateDelivered) {
			released = append(released, row.Id)
		}
	}
	if len(released) == 0 {
		return
	}
	ReleaseMessages(l.store, operationId)
	l.store.Event(kernelString(question["task_id"]), "conversation.turn_retried", map[string]any{
		"operationId": operationId,
		"questionId":  kernelString(question["id"]),
		"messages":    released,
	})
}

func (l *OperationLifecycle) Escalate(taskId, questionId, prompt string) string {
	return l.transaction(func(tx *TaskStore) any {
		l := l.scoped(tx)
		row := kernelRow(l.store.Db, `SELECT node_id,kind,data FROM questions
        WHERE id=? AND task_id=? AND status='open'`, questionId, taskId)
		if row == nil {
			Raise("invalid_question", "No open question in this task")
		}
		var source Json
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &source); err != nil {
			panic(err)
		}
		l.store.ResolveQuestion(questionId, map[string]any{"type": "escalated", "prompt": prompt})
		defects := []any{}
		if record, ok := jsonRecord(source); ok {
			if value, ok := record["defects"]; ok {
				if list, ok := value.([]any); ok {
					defects = list
				}
			}
		}
		escalated := InsertQuestion(l.store, QuestionInput{
			TaskId: taskId,
			NodeId: kernelString(row["node_id"]),
			Kind:   "waiting",
			Data: map[string]any{
				"requestType":   "noncompliance_decision",
				"prompt":        prompt,
				"escalatedFrom": kernelString(row["kind"]),
				"defects":       defects,
			},
		})
		l.store.Event(taskId, "problem.escalated", map[string]any{
			"questionId":  questionId,
			"nodeId":      kernelString(row["node_id"]),
			"kind":        kernelString(row["kind"]),
			"escalatedTo": escalated.Id,
		})
		return escalated.Id
	}).(string)
}
