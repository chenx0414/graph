package graph

// OpenQuestion asks the question a task is waiting on.
func (s *TaskStore) OpenQuestion(id, taskID, nodeID string, operationID any, kind string, data any, owner QuestionOwner) {
	kernelExec(s.DB, "INSERT INTO questions(id,task_id,node_id,operation_id,kind,data,owner) VALUES(?,?,?,?,?,?,?)",
		id, taskID, nodeID, operationID, kind, CanonicalJSON(data), string(owner))
}

// ResolveQuestion answers one question, whatever state it is in.
func (s *TaskStore) ResolveQuestion(questionID string, answer any) {
	kernelExec(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE id=?", CanonicalJSON(answer), questionID)
}

// ResolveOpenQuestion answers one question that is still open.
func (s *TaskStore) ResolveOpenQuestion(questionID string, answer any) {
	kernelExec(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE id=? AND status='open'", CanonicalJSON(answer), questionID)
}

// ResolveOperationQuestions answers every open question of one operation.
func (s *TaskStore) ResolveOperationQuestions(operationID string, answer any) {
	kernelExec(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'", CanonicalJSON(answer), operationID)
}

// ResolveOperationRecoveryQuestions answers the open recovery questions of
// one operation.
func (s *TaskStore) ResolveOperationRecoveryQuestions(operationID string, answer any) {
	kernelExec(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND kind='recovery' AND status='open'", CanonicalJSON(answer), operationID)
}

// ResolveTaskQuestions answers every open question of one task, and says how
// many it answered.
func (s *TaskStore) ResolveTaskQuestions(taskID string, answer any) int64 {
	return kernelChanges(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND status='open'", CanonicalJSON(answer), taskID)
}

// ResolveNodeBudgetQuestions answers the open budget questions of one node,
// and says how many it answered.
func (s *TaskStore) ResolveNodeBudgetQuestions(taskID, nodeID string, answer any) int64 {
	return kernelChanges(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'", CanonicalJSON(answer), taskID, nodeID)
}

// AmendQuestionData replaces the data of one question, which is how a
// question that is still open learns something new.
func (s *TaskStore) AmendQuestionData(questionID string, data any) {
	kernelExec(s.DB, "UPDATE questions SET data=? WHERE id=?", CanonicalJSON(data), questionID)
}
