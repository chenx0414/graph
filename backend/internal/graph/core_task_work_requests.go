package graph

import "encoding/json"

type WorkRevision struct {
	Revision   int64    `json:"revision"`
	ProjectID  *string  `json:"projectId"`
	Brief      string   `json:"brief"`
	Acceptance []string `json:"acceptance"`
	CreatedAt  int64    `json:"createdAt"`
}

type WorkRecord struct {
	ID              string         `json:"id"`
	ProjectID       *string        `json:"projectId"`
	ConversationID  string         `json:"conversationId"`
	SourceMessageID string         `json:"sourceMessageId"`
	State           string         `json:"state"`
	Revision        int64          `json:"revision"`
	Brief           string         `json:"brief"`
	Acceptance      []string       `json:"acceptance"`
	ExecutionPaused bool           `json:"executionPaused"`
	Revisions       []WorkRevision `json:"revisions"`
}

func (s *TaskStore) CreateWork(id, conversationID, sourceID, brief string, projectID *string, acceptance []string, now int64) {
	kernelExec(s.Db, `INSERT INTO work_requests(id,conversation_id,project_id,source_message_id,revision,state,created_at,updated_at)
 VALUES(?,?,?,?,1,'clarifying',?,?)`, id, conversationID, projectID, sourceID, now, now)
	s.insertWorkRevision(id, 1, brief, projectID, acceptance, now)
}

func (s *TaskStore) insertWorkRevision(id string, revision int64, brief string, projectID *string, acceptance []string, now int64) {
	kernelExec(s.Db, "INSERT INTO work_request_revisions(work_id,revision,brief,project_id,acceptance,created_at) VALUES(?,?,?,?,?,?)", id, revision, brief, projectID, CanonicalJSON(acceptance), now)
}

func (s *TaskStore) ReviseWork(id string, expected int64, brief string, projectID *string, acceptance []string, now int64) {
	changed := kernelChanges(s.Db, `UPDATE work_requests SET revision=revision+1,project_id=COALESCE(?,project_id),updated_at=?
 WHERE id=? AND revision=? AND state='clarifying'`, projectID, now, id, expected)
	if changed == 0 {
		Raise("stale_work", "The work changed or cannot be revised; read it again")
	}
	row := kernelRow(s.Db, "SELECT project_id FROM work_requests WHERE id=?", id)
	s.insertWorkRevision(id, expected+1, brief, conversationNullableString(row["project_id"]), acceptance, now)
}

func (s *TaskStore) Work(id string) WorkRecord {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	return s.workInTransaction(id)
}

func (s *TaskStore) workInTransaction(id string) WorkRecord {
	row := kernelRow(s.Db, `SELECT w.id,w.conversation_id,w.project_id,w.source_message_id,w.state,w.revision,w.execution_paused,r.brief,r.acceptance
 FROM work_requests w JOIN work_request_revisions r ON r.work_id=w.id AND r.revision=w.revision WHERE w.id=?`, id)
	if row == nil {
		Raise("not_found", "Work not found")
	}
	revisions := []WorkRevision{}
	for _, r := range kernelRows(s.Db, "SELECT revision,brief,project_id,acceptance,created_at FROM work_request_revisions WHERE work_id=? ORDER BY revision", id) {
		acceptance := []string{}
		if err := json.Unmarshal([]byte(kernelString(r["acceptance"])), &acceptance); err != nil {
			panic(err)
		}
		revisions = append(revisions, WorkRevision{Revision: kernelInt(r["revision"]), ProjectID: conversationNullableString(r["project_id"]), Brief: kernelString(r["brief"]), Acceptance: acceptance, CreatedAt: kernelInt(r["created_at"])})
	}
	acceptance := []string{}
	if err := json.Unmarshal([]byte(kernelString(row["acceptance"])), &acceptance); err != nil {
		panic(err)
	}
	return WorkRecord{ID: id, ProjectID: conversationNullableString(row["project_id"]), ConversationID: kernelString(row["conversation_id"]), SourceMessageID: kernelString(row["source_message_id"]), State: kernelString(row["state"]), Revision: kernelInt(row["revision"]), Brief: kernelString(row["brief"]), Acceptance: acceptance, ExecutionPaused: kernelInt(row["execution_paused"]) != 0, Revisions: revisions}
}

func (s *TaskStore) ProjectWork(projectID string) []WorkRecord {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	out := []WorkRecord{}
	for _, row := range kernelRows(s.Db, "SELECT id FROM work_requests WHERE project_id=? ORDER BY created_at,id", projectID) {
		out = append(out, s.workInTransaction(kernelString(row["id"])))
	}
	return out
}

func (s *TaskStore) MarkWorkDispatched(id string, revision int64) {
	changed := kernelChanges(s.Db, `UPDATE work_requests SET state='dispatched',updated_at=?
 WHERE id=? AND revision=? AND state IN ('clarifying','ready') AND execution_paused=0`, NowMillis(), id, revision)
	if changed == 0 {
		Raise("stale_work", "The work changed, is paused, or was already dispatched")
	}
}

func (s *TaskStore) PauseProjectWork(projectID string) {
	kernelExec(s.Db, "UPDATE work_requests SET execution_paused=1 WHERE project_id=? AND state NOT IN ('completed','cancelled')", projectID)
}

func (s *TaskStore) ResumeWorkExecution(workID string) {
	kernelExec(s.Db, "UPDATE work_requests SET execution_paused=0 WHERE id=? AND state NOT IN ('completed','cancelled')", workID)
}
