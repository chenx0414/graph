package graph

// OpenQuestion asks the question a task is waiting on.
func (s *TaskStore) OpenQuestion(id, taskID, nodeID string, operationID any, kind string, data any, owner QuestionOwner) {
	kernelExec(s.DB, "INSERT INTO questions(id,task_id,node_id,operation_id,kind,data,owner,asked_at) VALUES(?,?,?,?,?,?,?,?)",
		id, taskID, nodeID, operationID, kind, CanonicalJSON(data), string(owner), NowMillis())
}

func (s *TaskStore) RouteQuestion(id, stage string) {
	kernelExec(s.DB, "UPDATE questions SET route_stage=?,route_revision=1 WHERE id=?", stage, id)
}

func (s *TaskStore) AdvanceQuestionRevision(id, stage string, revision int64) bool {
	return kernelChanges(s.DB, "UPDATE questions SET route_revision=route_revision+1 WHERE id=? AND route_stage=? AND route_revision=? AND status='open'", id, stage, revision) == 1
}

func (s *TaskStore) SetQuestionHandler(id, stage string, owner QuestionOwner, data any) {
	kernelExec(s.DB, "UPDATE questions SET route_stage=?,owner=?,data=?,route_revision=route_revision+1 WHERE id=? AND status='open'", stage, string(owner), CanonicalJSON(data), id)
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

// MarkQuestionAutoAnswered records that the harness answered for the person.
//
// It is the only trace of a decision nobody made: the answer says what was
// chosen, this says the choice was not theirs, so the card can say so.
func (s *TaskStore) MarkQuestionAutoAnswered(questionID string, at int64) {
	kernelExec(s.DB, `UPDATE questions SET data=json_set(COALESCE(data,'{}'),'$.autoAnsweredAt',?)
          WHERE id=?`, at, questionID)
}

// RearmQuestion restarts the wait on a question the person asked to leave open.
//
// The card stops shouting for another deadline and keeps the decision: the
// question is still open, still theirs, and the harness still knows it waited.
func (s *TaskStore) RearmQuestion(taskID, questionID string) {
	now := NowMillis()
	kernelExec(s.DB, `UPDATE questions SET asked_at=?,
	  data=json_set(COALESCE(data,'{}'),
	    '$.waitedTimes', COALESCE(json_extract(data,'$.waitedTimes'),0)+1,
	    '$.keptWaitingAt', ?)
	  WHERE id=? AND task_id=? AND status='open'`, now, now, questionID, taskID)
}

// EscalateQuestionOwnership hands an open question to the person, with the
// reason it reached them.
//
// Re-owning, not replacing: the question keeps its kind, its label and the
// answers it already accepts. A new waiting question would throw those away
// and leave the person with a free-text box.
func (s *TaskStore) EscalateQuestionOwnership(questionID string, escalatedAt int64, from string, waitedMs int64, prompt string) {
	kernelExec(s.DB, `UPDATE questions SET owner='user', route_stage=NULL,
 data=json_set(data,'$.escalatedAt',?,'$.escalatedFrom',?,'$.escalatedWaitedMs',?,'$.escalationPrompt',?)
 WHERE id=? AND status='open' AND data IS NOT NULL`, escalatedAt, from, waitedMs, prompt, questionID)
}
