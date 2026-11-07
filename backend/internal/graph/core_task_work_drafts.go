package graph

import "encoding/json"

type WorkDraft struct {
	WorkID        string         `json:"workId"`
	Version       int64          `json:"version"`
	WorkRevision  int64          `json:"workRevision"`
	DraftRevision int64          `json:"draftRevision"`
	Proposal      map[string]any `json:"proposal"`
	Digest        string         `json:"digest"`
	Archived      bool           `json:"archived"`
	Deleted       bool           `json:"deleted"`
	Stale         bool           `json:"stale"`
}

func (s *TaskStore) insertWorkDraft(workID string, version, workRevision int64, spec, digest string, now int64) {
	kernelExec(s.Db, `INSERT INTO work_drafts(work_id,version,work_revision,draft_revision,spec,digest,created_at,updated_at)
 VALUES(?,?,?,1,?,?,?,?)`, workID, version, workRevision, spec, digest, now, now)
}

func (s *TaskStore) updateWorkDraft(workID string, version, expectedDraftRevision int64, spec, digest string, now int64) {
	changed := kernelChanges(s.Db, `UPDATE work_drafts SET draft_revision=draft_revision+1,spec=?,digest=?,updated_at=?
 WHERE work_id=? AND version=? AND draft_revision=? AND archived_at IS NULL AND deleted_at IS NULL`,
		spec, digest, now, workID, version, expectedDraftRevision)
	if changed == 0 {
		Raise("stale_draft", "The draft changed; read it again")
	}
}

func (s *TaskStore) setWorkDraftState(workID string, version, expected int64, action string, now int64) {
	var sql string
	switch action {
	case "archive":
		sql = `UPDATE work_drafts SET archived_at=?,draft_revision=draft_revision+1,updated_at=? WHERE work_id=? AND version=? AND draft_revision=? AND archived_at IS NULL AND deleted_at IS NULL`
	case "restore":
		sql = `UPDATE work_drafts SET archived_at=NULL,draft_revision=draft_revision+1,updated_at=? WHERE work_id=? AND version=? AND draft_revision=? AND archived_at IS NOT NULL AND deleted_at IS NULL`
	case "delete":
		sql = `UPDATE work_drafts SET deleted_at=?,draft_revision=draft_revision+1,updated_at=? WHERE work_id=? AND version=? AND draft_revision=? AND deleted_at IS NULL`
	default:
		Raise("invalid_input", "Unknown draft action")
	}
	args := []any{now, now, workID, version, expected}
	if action == "restore" {
		args = []any{now, workID, version, expected}
	}
	if kernelChanges(s.Db, sql, args...) == 0 {
		Raise("stale_draft", "The draft changed or cannot perform this action; read it again")
	}
}

const (
	draftCurrent = false
	draftAnyState = true
)

func draftRefusal(code, message string) {
	Raise(code, code+": "+message)
}

func (s *TaskStore) workDraftInTransaction(workID string, version int64, anyState bool) WorkDraft {
	if kernelRow(s.Db, "SELECT id FROM work_requests WHERE id=?", workID) == nil {
		draftRefusal("work_not_found", "work "+workID+" is unknown, so it has no drafts")
	}
	row := kernelRow(s.Db, `SELECT d.*,w.revision AS current_revision FROM work_drafts d JOIN work_requests w ON w.id=d.work_id
 WHERE d.work_id=? AND d.version=?`, workID, version)
	if row == nil {
		versions := []string{}
		for _, held := range kernelRows(s.Db, "SELECT version FROM work_drafts WHERE work_id=? AND deleted_at IS NULL ORDER BY version", workID) {
			versions = append(versions, itoa(int(kernelInt(held["version"]))))
		}
		known := "this work has no drafts"
		if len(versions) > 0 {
			known = "its versions are " + joinComma(versions)
		}
		draftRefusal("draft_version_not_found", "work "+workID+" has no draft version "+itoa(int(version))+"; "+known)
	}
	if !anyState && row["deleted_at"] != nil {
		draftRefusal("draft_deleted", "draft version "+itoa(int(version))+" of work "+workID+" was deleted")
	}
	if !anyState && row["archived_at"] != nil {
		draftRefusal("draft_archived", "draft version "+itoa(int(version))+" of work "+workID+" was archived; read the current draft instead")
	}
	var proposal map[string]any
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &proposal); err != nil {
		panic(err)
	}
	return WorkDraft{WorkID: workID, Version: version, WorkRevision: kernelInt(row["work_revision"]),
		DraftRevision: kernelInt(row["draft_revision"]), Proposal: proposal, Digest: kernelString(row["digest"]),
		Archived: row["archived_at"] != nil, Deleted: row["deleted_at"] != nil,
		Stale: kernelInt(row["work_revision"]) != kernelInt(row["current_revision"])}
}

func (s *TaskStore) WorkDraft(workID string, version int64) WorkDraft {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	return s.workDraftInTransaction(workID, version, draftCurrent)
}

func (s *TaskStore) WorkDrafts(workID string, archived bool) []WorkDraft {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	s.workInTransaction(workID)
	filter := "IS NULL"
	if archived {
		filter = "IS NOT NULL"
	}
	out := []WorkDraft{}
	for _, row := range kernelRows(s.Db, "SELECT version FROM work_drafts WHERE work_id=? AND deleted_at IS NULL AND archived_at "+filter+" ORDER BY version", workID) {
		out = append(out, s.workDraftInTransaction(workID, kernelInt(row["version"]), draftAnyState))
	}
	return out
}
