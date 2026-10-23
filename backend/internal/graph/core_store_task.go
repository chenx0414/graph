package graph

import (
	"database/sql"
)

func (s *TaskStore) Task(id string) TaskRow {
	var row TaskRow
	var accepted sql.NullInt64
	var integrationBranch, integrationSha, targetSha sql.NullString
	err := s.DB.QueryRow(`SELECT id, project_id, request, requirement_version, latest_proposal, accepted_proposal, target_branch, phase, paused, created_seq, graph_version, integration_branch, integration_sha, target_sha, conversation_id, decision_digest FROM tasks WHERE id=?`, id).Scan(
		&row.ID, &row.ProjectID, &row.Request, &row.RequirementVersion, &row.LatestProposal, &accepted, &row.TargetBranch, &row.Phase, &row.Paused, &row.CreatedSeq, &row.GraphVersion, &integrationBranch, &integrationSha, &targetSha, &row.ConversationID, &row.DecisionDigest,
	)
	if accepted.Valid {
		value := accepted.Int64
		row.AcceptedProposal = &value
	}
	if integrationBranch.Valid {
		value := integrationBranch.String
		row.IntegrationBranch = &value
	}
	if integrationSha.Valid {
		value := integrationSha.String
		row.IntegrationSha = &value
	}
	if targetSha.Valid {
		value := targetSha.String
		row.TargetSha = &value
	}
	if err == sql.ErrNoRows {
		Raise("not_found", "Task not found")
	}
	if err != nil {
		panic(err)
	}
	return row
}
