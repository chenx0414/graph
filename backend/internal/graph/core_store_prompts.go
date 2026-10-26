package graph

import (
	"database/sql"
)

type SystemPromptRecord struct {
	OperationID string
	At          int64
	Text        string
	Tools       sql.NullString
}

func (s *TaskStore) NodeSystemPrompt(taskID, nodeID string) *SystemPromptRecord {
	var rec SystemPromptRecord
	var settled, dispatched sql.NullInt64
	err := s.DB.QueryRow(`SELECT id, settled_at, dispatched_at, system_prompt, tool_declarations FROM operations WHERE task_id = ? AND node_id = ? AND system_prompt IS NOT NULL ORDER BY rowid DESC LIMIT 1`, taskID, nodeID).Scan(&rec.OperationID, &settled, &dispatched, &rec.Text, &rec.Tools)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		panic(err)
	}
	if settled.Valid {
		rec.At = settled.Int64
	} else if dispatched.Valid {
		rec.At = dispatched.Int64
	}
	return &rec
}

func (s *TaskStore) ConversationSystemPrompt(anchorTaskID string) *SystemPromptRecord {
	return s.NodeSystemPrompt(anchorTaskID, "master")
}
