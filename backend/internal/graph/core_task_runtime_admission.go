package graph

func (runtime *TaskRuntime) masterRefusal() string {
	if runtime.master == nil {
		return "No configured definition for a master agent"
	}
	if runtime.masterModel() != nil {
		return ""
	}
	entries := runtime.liveConfiguredEntries()
	if len(entries) == 0 {
		return "No configured model for a master agent"
	}
	for _, entry := range entries {
		if runtime.liveCredentialFor(entry.ModelEntry) == nil {
			return "No credential bound for model " + entry.Id
		}
	}
	return "No credential bound for a master agent"
}

func (runtime *TaskRuntime) refuseUndispatchableTurn(conversationId string) {
	reason := runtime.masterRefusal()
	if reason == "" {
		return
	}
	conversation := ConversationRowOf(runtime.store, conversationId)
	if questionMasterNode(runtime.store, conversation.AnchorTaskId) != nil {
		return
	}
	RecordTurnRefusal(runtime.store, conversationId, reason)
}

func (runtime *TaskRuntime) refuseUndispatchableTask(taskId string) {
	reason := runtime.masterRefusal()
	if reason == "" {
		return
	}
	InsertQuestion(runtime.store, QuestionInput{
		TaskId: taskId,
		Kind:   "model_unavailable",
		Data:   map[string]any{"reason": reason},
	})
}

func (runtime *TaskRuntime) resolveUndispatchableQuestion(taskId string) string {
	questions := kernelRows(runtime.store.Db, "SELECT id,data FROM questions WHERE task_id=? AND kind='model_unavailable' AND status='open'", taskId)
	reason := ""
	for _, question := range questions {
		runtime.store.ResolveQuestion(kernelString(question["id"]), map[string]any{"type": "retry"})
		if reason == "" {
			reason = mapString(questionParseRecord(kernelString(question["data"])), "reason")
		}
	}
	return reason
}

func (runtime *TaskRuntime) answerUndispatchableTask(taskId, questionId string, answer Answer) {
	if answer.Type != "retry" {
		return
	}
	question := kernelRow(runtime.store.Db, "SELECT kind,status FROM questions WHERE id=? AND task_id=?", questionId, taskId)
	if question == nil || kernelString(question["kind"]) != "model_unavailable" {
		return
	}
	if kernelString(question["status"]) != "open" {
		return
	}
	if questionMasterNode(runtime.store, taskId) != nil {
		return
	}
	if reason := runtime.masterRefusal(); reason != "" {
		Raise("model_unavailable", reason)
	}
	runtime.createMasterNode(taskId)
	active := kernelString(kernelRow(runtime.store.Db, "SELECT active_task FROM runtime")["active_task"])
	if active == "" {
		runtime.store.SetRuntimeActiveTask(taskId)
	}
	runtime.store.Event(taskId, "task.master_recovered", map[string]any{"reason": "a model could be called again"})
}

func (runtime *TaskRuntime) piRsiChannel() *PiAdapterRsi {
	service := runtime.rsi
	if service == nil {
		return nil
	}
	return &PiAdapterRsi{
		Available:    service.Available,
		CheckoutRoot: func() *string { return service.Root },
		Status:       func(compare bool) any { return service.Status(compare) },
		Apply: func(input any, context PiAdapterRsiContext) map[string]any {
			receipt := service.Apply(input, RsiApplyContext{
				OperationId:    context.OperationId,
				Store:          runtime.store,
				TaskId:         context.TaskId,
				ConversationId: context.ConversationId,
			})
			record, _ := jsonClone(receipt).(map[string]any)
			if record == nil {
				record = map[string]any{}
			}
			return record
		},
	}
}
