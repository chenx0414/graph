package graph

import (
	"encoding/json"
)

// Block parks a node behind a question.
func (l *OperationLifecycle) Block(taskId, nodeId, kind string, data Json, operationId *string) string {
	return l.transaction(func() any {
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
			if operation != nil && operation.Operation.AccessPolicy != nil &&
				operation.Operation.AccessPolicy.AutoApprove.Permission && grant != "" {
				autoAnswer = &QuestionAutoAnswer{
					Answer:       Answer{Type: "grant", Grant: grant},
					PolicyDigest: operation.Operation.AccessPolicy.Digest,
					Resume:       boolPtr(true),
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
		// The node was left dispatchable on purpose, but it is not woken here:
		// the queued message or wake that brought it back is what runs it, and a
		// turn nobody asked for would spend a model call per failure.
		return question.Id
	}).(string)
}

// Answer resolves a human answer and changes the formal state it implies.
func (l *OperationLifecycle) Answer(taskId, questionId string, answer Answer, models func() []ModelEntry) {
	l.transaction(func() any {
		question := kernelRow(l.store.Db, "SELECT * FROM questions WHERE id=? AND task_id=?", questionId, taskId)
		if question == nil || kernelString(question["status"]) != "open" {
			Raise("invalid_question", "No open question in this task")
		}
		kind := kernelString(question["kind"])
		nodeId := kernelString(question["node_id"])
		AssertQuestionAnswer(kind, answer)
		// "wait" is not a decision: the problem stays open, the clock starts
		// over, and nothing runs. Taking the decision away from the person would
		// be worse than the nagging it replaces.
		if answer.Type == "wait" {
			l.rearmQuestion(taskId, questionId)
			return nil
		}
		if kind == "budget" && answer.Type == "add_budget" {
			if answer.Tokens <= 0 {
				Raise("invalid_answer", "A positive token increment is required")
			}
			kernel := NewKernelStore(l.store)
			if kernel.LatestRevision(taskId) != nil {
				var data map[string]any
				if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
					panic(err)
				}
				executionId := ""
				if value, ok := data["executionId"].(string); ok {
					executionId = value
				}
				execution := kernel.Execution(executionId)
				if execution == nil || execution.TaskId != taskId || execution.NodeId != nodeId || execution.TokenBudget == nil {
					Raise("invalid_answer", "Budget question has no frozen execution quota")
				}
				quota := kernel.AuthorizedBudget(taskId, nodeId)
				budget := execution.TokenBudget.Budget
				if quota != nil {
					budget = quota.Budget
				}
				unlimited := execution.TokenBudget.Unlimited
				if quota != nil {
					unlimited = quota.Unlimited
				}
				if unlimited || !jsSafeInteger(int64(budget)+answer.Tokens) {
					Raise("invalid_answer", "Budget increment requires a finite quota within the safe integer range")
				}
				total := int64(budget) + answer.Tokens
				kernel.SetAuthorizedBudget(taskId, nodeId, &total)
				l.store.Event(taskId, "instance.budget_changed", map[string]any{"nodeId": nodeId, "tokens": total, "nextExecution": true})
			} else {
				instance := kernelRow(l.store.Db, "SELECT id FROM instances WHERE task_id=? AND node_id=?", taskId, nodeId)
				if instance == nil {
					Raise("not_found", "Unknown agent node")
				}
				AddBudget(l.store, kernelString(instance["id"]), answer.Tokens)
			}
		} else if kind == "unknown_usage" && (answer.Type == "usage" || answer.Type == "reconcile_usage") {
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
			// A question on a task that has no node has no node to re-pend: the
			// task itself is what the answer was about, and it is already
			// settled.
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
		// "acknowledge" on a problem whose outcome was never settled says "stop
		// asking me": the operation stays unknown (the fact is kept, not erased),
		// and the node stays parked so closing the problem cannot start a turn
		// nobody asked for. A new message or an explicit retry releases it.
		if kind == "recovery" && answer.Type == "acknowledge" {
			l.store.SetNodeBlocked(taskId, nodeId)
		}
		return nil
	})
}

// rearmQuestion restarts the wait on a problem the person asked to leave open.
//
// The card stops shouting for another deadline and keeps the decision, which is
// the difference between "wait" and dismissing it: the question is still open,
// still the person's, and the harness still knows it waited.
func (l *OperationLifecycle) rearmQuestion(taskId, questionId string) {
	now := NowMillis()
	kernelExec(l.store.Db, `UPDATE questions SET asked_at=?,
	  data=json_set(COALESCE(data,'{}'),
	    '$.waitedTimes', COALESCE(json_extract(data,'$.waitedTimes'),0)+1,
	    '$.keptWaitingAt', ?)
	  WHERE id=? AND task_id=? AND status='open'`, now, now, questionId, taskId)
	l.store.Event(taskId, "problem.kept_waiting", map[string]any{"questionId": questionId})
}

// releaseFailedTurnMessages puts the messages of a failed master turn back on
// the queue, so answering retry answers the same request again.
//
// Measured 2026-11-01: the retry answer only flipped the node back to pending,
// and the turn that then ran carried no user message at all - the person's
// click started something, just not the turn that failed. Re-pending the
// messages is deliberate: a retry re-runs that request, which is why the card
// says it spends another model call and may repeat that turn's tool calls.
func (l *OperationLifecycle) releaseFailedTurnMessages(question map[string]any) {
	operationId := kernelString(question["operation_id"])
	if operationId == "" || questionPolicy(kernelString(question["kind"])).Owner != QuestionOwnerMain {
		return
	}
	// Only the turn that is still the latest one can be re-run: an older
	// failure has already been superseded by a later turn, and re-pending its
	// messages would replay a request the conversation has moved past.
	latest := kernelRow(l.store.Db, "SELECT id FROM operations WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1",
		kernelString(question["task_id"]), kernelString(question["node_id"]))
	if latest == nil || kernelString(latest["id"]) != operationId {
		return
	}
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

// Escalate hands a main-owned problem to the user with the main Agent's explanation,
// and says which question now carries the decision.
func (l *OperationLifecycle) Escalate(taskId, questionId, prompt string) string {
	return l.transaction(func() any {
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
