package graph

import (
	"database/sql"
	"math"
)

type ToolCallInput struct {
	InstanceID string
	Tool       string
	Ms         float64
	IsError    bool
	At         *int64
	Target     any
}

func (s *TaskStore) RecordToolCall(input ToolCallInput) {
	var taskID, nodeID, role any
	err := s.DB.QueryRow(`SELECT n.task_id, n.id, json_extract(n.spec, '$.role') FROM nodes n WHERE n.instance_id = ?`, input.InstanceID).Scan(&taskID, &nodeID, &role)
	if err == sql.ErrNoRows {
		var present int
		qerr := s.DB.QueryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_nodes'").Scan(&present)
		if qerr == nil {
			err = s.DB.QueryRow(`SELECT n.task_id,n.node_id,b.role FROM kernel_nodes n LEFT JOIN kernel_node_bindings b ON b.task_id=n.task_id AND b.node_id=n.node_id WHERE n.instance_id=?`, input.InstanceID).Scan(&taskID, &nodeID, &role)
			if err == sql.ErrNoRows {
				err = nil
				taskID, nodeID, role = nil, nil, nil
			}
		} else {
			err = nil
			taskID, nodeID, role = nil, nil, nil
		}
	}
	if err != nil {
		panic(err)
	}
	ms := int64(math.Round(input.Ms))
	if ms < 0 {
		ms = 0
	}
	at := NowMillis()
	if input.At != nil {
		at = *input.At
	}
	isError := 0
	if input.IsError {
		isError = 1
	}
	if _, err := s.DB.Exec(`INSERT INTO tool_calls(instance_id, task_id, node_id, role, tool, ms, is_error, created_at, target) VALUES(?,?,?,?,?,?,?,?,?)`, input.InstanceID, taskID, nodeID, role, input.Tool, ms, isError, at, input.Target); err != nil {
		panic(err)
	}
}

func (s *TaskStore) PruneToolCalls(keepDays int) int64 {
	if keepDays == 0 {
		keepDays = ToolCallRetentionDays
	}
	cutoff := NowMillis() - int64(keepDays)*86400000
	res, err := s.DB.Exec("DELETE FROM tool_calls WHERE created_at < ?", cutoff)
	if err != nil {
		panic(err)
	}
	n, _ := res.RowsAffected()
	return n
}

func (s *TaskStore) ClearToolCalls() int64 {
	res, err := s.DB.Exec("DELETE FROM tool_calls")
	if err != nil {
		panic(err)
	}
	n, _ := res.RowsAffected()
	return n
}

func (s *TaskStore) ToolCallSpoolOffset(path string) int64 {
	var offset sql.NullInt64
	err := s.DB.QueryRow("SELECT offset FROM tool_call_spools WHERE path = ?", path).Scan(&offset)
	if err == sql.ErrNoRows {
		return 0
	}
	if err != nil {
		panic(err)
	}
	return offset.Int64
}

func (s *TaskStore) SetToolCallSpoolOffset(path string, offset int64) {
	if offset < 0 {
		offset = 0
	}
	if _, err := s.DB.Exec("INSERT INTO tool_call_spools(path, offset) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset", path, offset); err != nil {
		panic(err)
	}
}

func (s *TaskStore) ForgetToolCallSpools() {
	if _, err := s.DB.Exec("DELETE FROM tool_call_spools"); err != nil {
		panic(err)
	}
}

func (s *TaskStore) ForgetToolCallSpool(path string) {
	if _, err := s.DB.Exec("DELETE FROM tool_call_spools WHERE path = ?", path); err != nil {
		panic(err)
	}
}
