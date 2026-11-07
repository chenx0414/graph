package graph

// masterRefusal reads the reason a master turn cannot start, or an empty
// string when one can start.
//
// A turn needs a model that can be called, and the master model is the first
// configured model whose credential resolves. No master model therefore means
// that no model can be called at all: the turn would never start, and the
// message that asked for it would wait for a reply that cannot come. The
// reason names the model whose credential is missing, so the user knows what
// to fix.
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

// refuseUndispatchableTurn records why a master turn cannot start.
//
// The refusal covers the case where there is no turn to run at all. A
// conversation whose master node exists runs its turn, and that turn reports
// its own failure; a conversation without one would simply wait for a reply
// that cannot come, so the reason is given here instead.
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

// refuseUndispatchableTask asks the user why a task cannot start.
//
// A task needs a model that can be called. Without one it waits for a turn
// that cannot come, and the person who asked for it has no way of knowing
// that anything happened at all. The task is kept - the request is their work
// - and the reason is asked of them, because they are the only one who can
// fix it. The question closes itself once a model can be called again, and the
// task runs then.
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

// resolveUndispatchableQuestion closes the question that named why a task
// could not start.
//
// The question is open because no model could be called. A master node exists
// now, so the reason it named no longer holds and the question is answered
// the way a released problem is. The reason it named is returned, so the
// timeline can say why the task was waiting.
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

// answerUndispatchableTask handles the answer to a task that could not start.
// The task has no master node because no model could be called when it was
// created. A retry means "try again": when a model can be called now the
// master is created and the task runs, and when none can the reason still
// holds - so the answer is refused and the question stays open.
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
	// A task whose master exists is the runtime's own retry: the master is
	// re-pended and runs again.
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

// piRsiChannel binds the self-improvement service to the Agent session.
//
// The service is always there - it is the daemon that knows which checkout it
// runs from - but a change needs a checkout to change. `available` says so, and
// the tools read it: the status is worth reporting even without a checkout,
// because it names the reason, while an apply without one has nothing to do.
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
