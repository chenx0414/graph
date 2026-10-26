package graph

// RecordProposal records one version of a proposal.
func (s *TaskStore) RecordProposal(taskID string, version, requirementVersion int64, spec, decisionSnapshot any) {
	kernelExec(s.DB, "INSERT INTO proposals(task_id,version,requirement_version,spec,decision_snapshot) VALUES(?,?,?,?,?)",
		taskID, version, requirementVersion, spec, decisionSnapshot)
}

// RecordProposalDraft records one version of a proposal that is still a
// draft.
func (s *TaskStore) RecordProposalDraft(taskID string, version, requirementVersion int64, spec, decisionSnapshot any, draftRevision int64, draftDigest string) {
	kernelExec(s.DB, "INSERT INTO proposals(task_id,version,requirement_version,spec,decision_snapshot,draft_revision,draft_digest) VALUES(?,?,?,?,?,?,?)",
		taskID, version, requirementVersion, spec, decisionSnapshot, draftRevision, draftDigest)
}

// UpdateProposalDraft replaces the draft of one version of a proposal.
func (s *TaskStore) UpdateProposalDraft(taskID string, version, requirementVersion int64, spec, decisionSnapshot any, draftRevision int64, draftDigest string) {
	kernelExec(s.DB, "UPDATE proposals SET requirement_version=?,spec=?,decision_snapshot=?,draft_revision=?,draft_digest=? WHERE task_id=? AND version=?",
		requirementVersion, spec, decisionSnapshot, draftRevision, draftDigest, taskID, version)
}

// ArchiveProposal puts one version of a proposal away.
func (s *TaskStore) ArchiveProposal(taskID string, version int64, at int64) {
	kernelExec(s.DB, "UPDATE proposals SET archived_at=? WHERE task_id=? AND version=?", at, taskID, version)
}

// RestoreProposal brings one archived version of a proposal back.
func (s *TaskStore) RestoreProposal(taskID string, version int64) {
	kernelExec(s.DB, "UPDATE proposals SET archived_at=NULL WHERE task_id=? AND version=?", taskID, version)
}

// DeleteProposal says one version of a proposal was withdrawn.
func (s *TaskStore) DeleteProposal(taskID string, version int64, at int64) {
	kernelExec(s.DB, "UPDATE proposals SET deleted_at=? WHERE task_id=? AND version=?", at, taskID, version)
}
