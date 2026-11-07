package graph

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

func (s *TaskStore) ResolveQuestion(questionID string, answer any) {
	kernelExec(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE id=?", CanonicalJSON(answer), questionID)
}

func (s *TaskStore) ResolveOpenQuestion(questionID string, answer any) {
	kernelExec(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE id=? AND status='open'", CanonicalJSON(answer), questionID)
}

func (s *TaskStore) ResolveOperationQuestions(operationID string, answer any) {
	kernelExec(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'", CanonicalJSON(answer), operationID)
}

func (s *TaskStore) ResolveOperationRecoveryQuestions(operationID string, answer any) {
	kernelExec(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND kind='recovery' AND status='open'", CanonicalJSON(answer), operationID)
}

func (s *TaskStore) ResolveTaskQuestions(taskID string, answer any) int64 {
	return kernelChanges(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND status='open'", CanonicalJSON(answer), taskID)
}

func (s *TaskStore) ResolveNodeBudgetQuestions(taskID, nodeID string, answer any) int64 {
	return kernelChanges(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'", CanonicalJSON(answer), taskID, nodeID)
}

func (s *TaskStore) ResolveOpenHumanChecks(taskID, acceptanceID string, answer any) []string {
	rows := kernelRows(s.DB, `SELECT id FROM questions WHERE task_id=? AND kind='human_check' AND status='open'
    AND json_extract(data,'$.acceptanceId')=? ORDER BY rowid`, taskID, acceptanceID)
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		id := kernelString(row["id"])
		if kernelChanges(s.DB, "UPDATE questions SET status='resolved',answer=? WHERE id=? AND status='open'", CanonicalJSON(answer), id) == 1 {
			ids = append(ids, id)
		}
	}
	return ids
}

func (s *TaskStore) AmendQuestionData(questionID string, data any) {
	kernelExec(s.DB, "UPDATE questions SET data=? WHERE id=?", CanonicalJSON(data), questionID)
}

func (s *TaskStore) MarkQuestionAutoAnswered(questionID string, at int64) {
	kernelExec(s.DB, `UPDATE questions SET data=json_set(COALESCE(data,'{}'),'$.autoAnsweredAt',?)
          WHERE id=?`, at, questionID)
}

func (s *TaskStore) RearmQuestion(taskID, questionID string) {
	now := NowMillis()
	kernelExec(s.DB, `UPDATE questions SET asked_at=?,
	  data=json_set(COALESCE(data,'{}'),
	    '$.waitedTimes', COALESCE(json_extract(data,'$.waitedTimes'),0)+1,
	    '$.keptWaitingAt', ?)
	  WHERE id=? AND task_id=? AND status='open'`, now, now, questionID, taskID)
}

func (s *TaskStore) EscalateQuestionOwnership(questionID string, escalatedAt int64, from string, waitedMs int64, prompt string) {
	kernelExec(s.DB, `UPDATE questions SET owner='user', route_stage=NULL,
 data=json_set(data,'$.escalatedAt',?,'$.escalatedFrom',?,'$.escalatedWaitedMs',?,'$.escalationPrompt',?)
 WHERE id=? AND status='open' AND data IS NOT NULL`, escalatedAt, from, waitedMs, prompt, questionID)
}
