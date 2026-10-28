package graph

// RecordNodeQuestion preserves the request before the model turn stops.
func (k *KernelStore) RecordNodeQuestion(taskID, nodeID string, question PiAdapterAskedQuestion) {
	request := map[string]any{"prompt": question.Prompt, "why": question.Why, "options": question.Options, "multiple": question.Multiple}
	active := k.RunningExecution(taskID, nodeID)
	if active == nil {
		Raise("invalid_execution", "A running execution is required")
	}
	k.Store.Command("node-question:"+taskID+":"+nodeID, question.RequestID, map[string]any{"executionId": active.Id, "question": request}, func() any {
		execution := k.RunningExecution(taskID, nodeID)
		if execution == nil || execution.Id != active.Id || execution.SubmissionId != nil {
			Raise("invalid_execution", "A running unsubmitted execution is required")
		}
		queue := kernelRow(k.Db, "SELECT seq FROM kernel_queue WHERE task_id=? AND node_id=? AND state='claimed'", taskID, nodeID)
		if queue == nil {
			Raise("invalid_queue", "The running node has no claimed input")
		}
		if kernelRow(k.Db, "SELECT execution_id FROM node_questions WHERE execution_id=? AND state IN ('recorded','parked')", execution.Id) != nil {
			Raise("invalid_question", "This execution already has a question")
		}
		kernelExec(k.Db, `INSERT INTO node_questions(id,execution_id,task_id,node_id,queue_seq,request_id,payload,state,manual_pause)
 VALUES(?,?,?,?,?,?,?,'recorded',COALESCE((SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id=?),0))`, graphUUID(), execution.Id, taskID, nodeID, kernelInt(queue["seq"]), question.RequestID, CanonicalJSON(request), taskID, nodeID)
		k.Store.Event(taskID, "graph.question.recorded", map[string]any{"executionId": execution.Id, "nodeId": nodeID})
		return map[string]any{"executionId": execution.Id}
	})
}

func (k *KernelStore) MarkNodeQuestionAnswered(questionID string) {
	kernelExec(k.Db, "UPDATE node_questions SET state='answered' WHERE question_id=? AND state='parked'", questionID)
}

func (k *KernelStore) SetQuestionManualPause(taskID, nodeID string, paused bool) {
	if !paused && k.HasPendingProviderCall(taskID, nodeID) {
		Raise("unknown_usage", "Reconcile the node's pending provider calls before resuming")
	}
	if !paused && kernelRow(k.Db, "SELECT id FROM node_questions WHERE task_id=? AND node_id=? AND state IN ('recorded','parked')", taskID, nodeID) != nil {
		Raise("paused", "The node is waiting for its supervisor's answer")
	}
	if paused {
		kernelExec(k.Db, "UPDATE node_questions SET manual_pause=1 WHERE task_id=? AND node_id=? AND state IN ('recorded','parked')", taskID, nodeID)
	}
}

func (k *KernelStore) AnswerNodeQuestion(questionID string, answer Answer) {
	row := kernelRow(k.Db, "SELECT task_id,node_id,manual_pause FROM node_questions WHERE question_id=? AND state='parked'", questionID)
	if row == nil {
		Raise("invalid_question", "The node question is not parked")
	}
	taskID, nodeID := kernelString(row["task_id"]), kernelString(row["node_id"])
	if k.HasPendingProviderCall(taskID, nodeID) {
		Raise("unknown_usage", "Reconcile the node's pending provider calls before answering its question")
	}
	k.Store.ResolveQuestion(questionID, answer)
	k.MarkNodeQuestionAnswered(questionID)
	if kernelInt(row["manual_pause"]) == 0 {
		k.SetNodeQueuePausedInCurrentTransaction(taskID, nodeID, false)
		k.SetNativePause(taskID, false, nodeID, 0)
	}
	k.UnblockNode(taskID, nodeID)
	k.Store.Event(taskID, "graph.question.answered", map[string]any{"questionId": questionID, "nodeId": nodeID})
}

func (k *KernelStore) HasRecordedNodeQuestion(executionID string) bool {
	return kernelRow(k.Db, "SELECT execution_id FROM node_questions WHERE execution_id=? AND state='recorded'", executionID) != nil
}

func (k *KernelStore) BlockRecordedNodeQuestion(executionID, reason string) {
	k.Store.Transaction(func() any {
		row := kernelRow(k.Db, "SELECT task_id,node_id,queue_seq FROM node_questions WHERE execution_id=? AND state='recorded'", executionID)
		if row == nil {
			return nil
		}
		taskID, nodeID := kernelString(row["task_id"]), kernelString(row["node_id"])
		k.FinishExecution(executionID, "blocked")
		k.BlockQueued(taskID, kernelInt(row["queue_seq"]))
		k.SetNodeQueuePausedInCurrentTransaction(taskID, nodeID, true)
		k.ParkNodeForQuestion(taskID, nodeID)
		k.PublishRecordedNodeQuestion(executionID, reason)
		return nil
	})
}

// ParkNodeQuestion preserves the original queue identity and only then notifies its supervisor.
func (k *KernelStore) ParkNodeQuestion(executionID string) {
	k.Store.Transaction(func() any {
		row := kernelRow(k.Db, "SELECT * FROM node_questions WHERE execution_id=? AND state='recorded'", executionID)
		if row == nil {
			return nil
		}
		taskID, nodeID := kernelString(row["task_id"]), kernelString(row["node_id"])
		queue := kernelRow(k.Db, "SELECT seq FROM kernel_queue WHERE task_id=? AND node_id=? AND seq=? AND state='claimed'", taskID, nodeID, row["queue_seq"])
		if queue == nil || k.RunningExecution(taskID, nodeID) == nil {
			Raise("invalid_state", "Question execution is not ready to park")
		}
		k.FinishExecution(executionID, "blocked")
		k.BlockQueued(taskID, kernelInt(row["queue_seq"]))
		k.SetNodeQueuePausedInCurrentTransaction(taskID, nodeID, true)
		k.SetNativePause(taskID, true, nodeID, 0)
		k.ParkNodeForQuestion(taskID, nodeID)
		k.PublishRecordedNodeQuestion(executionID, "")
		return nil
	})
}

// PublishRecordedNodeQuestion is called inside the transaction that parks the input.
func (k *KernelStore) PublishRecordedNodeQuestion(executionID, recoveryReason string) {
	row := kernelRow(k.Db, "SELECT * FROM node_questions WHERE execution_id=? AND state='recorded'", executionID)
	if row == nil {
		return
	}
	taskID, nodeID := kernelString(row["task_id"]), kernelString(row["node_id"])
	data := questionParseRecord(kernelString(row["payload"]))
	data["requestType"] = "node_decision"
	data["executionId"] = executionID
	data["queueSeq"] = kernelInt(row["queue_seq"])
	if recoveryReason != "" {
		data["recoveryReason"] = recoveryReason
		data["pendingProviderCalls"] = k.PendingProviderCalls(taskID, nodeID)
	}
	questionID := graphUUID()
	k.Store.OpenQuestion(questionID, taskID, nodeID, nil, "waiting", data, QuestionOwnerMain)
	k.Store.RouteQuestion(questionID, "project")
	kernelExec(k.Db, "UPDATE node_questions SET state='parked',question_id=? WHERE execution_id=? AND state='recorded'", questionID, executionID)
	WakeMaster(k.Store, WakeIntent{TaskID: taskID, Kind: "node_question", DedupeKey: questionID, Data: map[string]any{"questionId": questionID, "revision": 1, "graphId": taskID, "nodeId": nodeID}, HasData: true})
	k.Store.Event(taskID, "graph.question.parked", map[string]any{"questionId": questionID, "executionId": executionID, "nodeId": nodeID, "recoveryReason": recoveryReason})
}
