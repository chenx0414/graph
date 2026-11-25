package graph

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"crypto/sha256"
)

var WRITE_TOOLS = map[string]bool{
	"write_file":  true,
	"edit":        true,
	"multiedit":   true,
	"multi_edit":  true,
	"file_edit":   true,
	"apply_patch": true,
}

const MAX_CAPTURE_TEXT_BYTES = 2 * 1024 * 1024

type WriteSnapshot struct {
	Exists    bool    `json:"exists"`
	Digest    *string `json:"digest"`
	SizeBytes *int64  `json:"sizeBytes"`
	Content   *string `json:"content"`
	Oversized bool    `json:"oversized"`
	Binary    bool    `json:"binary"`
}

type WriteRecord struct {
	TaskID     string
	NodeID     string
	InstanceID *string
	TurnID     string
	Path       string
	ToolName   string
	ToolCallID string
	Before     WriteSnapshot
	After      *WriteSnapshot
	CreatedAt  int64
}

type WriteCaptureInput struct {
	TaskID     string
	NodeID     string
	InstanceID *string
	TurnID     string
	ToolCallID string
	ToolName   string
	Path       string
	Workspace  string
}

type LaneChange struct {
	Path         string
	BeforeDigest *string
	AfterDigest  *string
	Status       string
}

func CapturePathFor(toolName string, path any) *string {
	if !WRITE_TOOLS[toolName] {
		return nil
	}
	text, ok := path.(string)
	if !ok || text == "" || strings.Contains(text, "\x00") {
		return nil
	}
	return &text
}

func missingSnapshot() WriteSnapshot {
	return WriteSnapshot{}
}

func SnapshotFile(workspace, path string) WriteSnapshot {
	root, err := filepath.EvalSymlinks(filepath.Clean(workspace))
	if err != nil {
		root = filepath.Clean(workspace)
	}
	target := path
	if !filepath.IsAbs(target) {
		target = filepath.Join(root, path)
	}
	target = filepath.Clean(target)
	if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
		panic(fmt.Errorf("Path is outside the lane workspace: %s", path))
	}
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		return missingSnapshot()
	}
	body, err := os.ReadFile(target)
	if err != nil {
		return missingSnapshot()
	}
	sum := sha256.Sum256(body)
	digest := fmt.Sprintf("%x", sum[:])
	size := int64(len(body))
	binary := strings.Contains(string(body), "\x00")
	oversized := size > MAX_CAPTURE_TEXT_BYTES
	snapshot := WriteSnapshot{Exists: true, Digest: &digest, SizeBytes: &size, Oversized: oversized, Binary: binary}
	if !binary && !oversized {
		text := string(body)
		snapshot.Content = &text
	}
	return snapshot
}

func RelativeLanePath(workspace, path string) string {
	root := filepath.Clean(workspace)
	target := path
	if !filepath.IsAbs(target) {
		target = filepath.Join(root, path)
	}
	target = filepath.Clean(target)
	if target == root {
		return ""
	}
	if !strings.HasPrefix(target, root+string(filepath.Separator)) {
		panic(fmt.Errorf("Path is outside the lane workspace: %s", path))
	}
	return filepath.ToSlash(target[len(root)+1:])
}

type WriteLedger struct {
	store *TaskStore
}

func (ledger *WriteLedger) Capture(side string, input WriteCaptureInput) *WriteRecord {
	path := CapturePathFor(input.ToolName, input.Path)
	if path == nil {
		return nil
	}
	snapshot := SnapshotFile(input.Workspace, *path)
	relativePath := RelativeLanePath(input.Workspace, *path)
	var record *WriteRecord
	ledger.store.Transaction(func(tx *TaskStore) {
		ledger := ledger.scoped(tx)
		row := ledger.lookup(input.TaskID, input.NodeID, input.TurnID, relativePath)
		if side == "open" {
			if row != nil {
				record = row
				return
			}
			ledger.insert(input, relativePath, snapshot, nil)
		} else if row == nil {
			missing := missingSnapshot()
			ledger.insert(input, relativePath, missing, &snapshot)
		} else {
			body, err := json.Marshal(snapshot)
			if err != nil {
				panic(err)
			}
			if _, err := ledger.store.Db.Exec(
				"UPDATE node_write_captures SET after=? WHERE task_id=? AND node_id=? AND turn_id=? AND path=?",
				string(body), input.TaskID, input.NodeID, input.TurnID, relativePath,
			); err != nil {
				panic(err)
			}
		}
		record = ledger.lookup(input.TaskID, input.NodeID, input.TurnID, relativePath)
	})
	return record
}

func (ledger *WriteLedger) insert(input WriteCaptureInput, relativePath string, before WriteSnapshot, after *WriteSnapshot) {
	beforeBody, err := json.Marshal(before)
	if err != nil {
		panic(err)
	}
	var afterBody any
	if after != nil {
		body, err := json.Marshal(after)
		if err != nil {
			panic(err)
		}
		afterBody = string(body)
	}
	var instance any
	if input.InstanceID != nil {
		instance = *input.InstanceID
	}
	if _, err := ledger.store.Db.Exec(`INSERT INTO node_write_captures
          (task_id,node_id,instance_id,turn_id,path,tool_name,tool_call_id,before,after,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,
		input.TaskID, input.NodeID, instance, input.TurnID, relativePath, input.ToolName, input.ToolCallID, string(beforeBody), afterBody, NowMillis(),
	); err != nil {
		panic(err)
	}
}

func (ledger *WriteLedger) lookup(taskID, nodeID, turnID, path string) *WriteRecord {
	row := ledger.store.Db.QueryRow("SELECT task_id,node_id,instance_id,turn_id,path,tool_name,tool_call_id,before,after,created_at FROM node_write_captures WHERE task_id=? AND node_id=? AND turn_id=? AND path=?", taskID, nodeID, turnID, path)
	return scanWrite(row)
}

func scanWrite(row *sql.Row) *WriteRecord {
	var record WriteRecord
	var instance, after sql.NullString
	var before string
	err := row.Scan(&record.TaskID, &record.NodeID, &instance, &record.TurnID, &record.Path, &record.ToolName, &record.ToolCallID, &before, &after, &record.CreatedAt)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		panic(err)
	}
	if instance.Valid {
		record.InstanceID = &instance.String
	}
	if err := json.Unmarshal([]byte(before), &record.Before); err != nil {
		panic(err)
	}
	if after.Valid {
		var snapshot WriteSnapshot
		if err := json.Unmarshal([]byte(after.String), &snapshot); err != nil {
			panic(err)
		}
		record.After = &snapshot
	}
	return &record
}

func (ledger *WriteLedger) Records(taskID, nodeID string) []WriteRecord {
	rows, err := ledger.store.Db.Query("SELECT task_id,node_id,instance_id,turn_id,path,tool_name,tool_call_id,before,after,created_at FROM node_write_captures WHERE task_id=? AND node_id=? ORDER BY created_at, path", taskID, nodeID)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []WriteRecord{}
	for rows.Next() {
		var record WriteRecord
		var instance, after sql.NullString
		var before string
		if err := rows.Scan(&record.TaskID, &record.NodeID, &instance, &record.TurnID, &record.Path, &record.ToolName, &record.ToolCallID, &before, &after, &record.CreatedAt); err != nil {
			panic(err)
		}
		if instance.Valid {
			record.InstanceID = &instance.String
		}
		if err := json.Unmarshal([]byte(before), &record.Before); err != nil {
			panic(err)
		}
		if after.Valid {
			var snapshot WriteSnapshot
			if err := json.Unmarshal([]byte(after.String), &snapshot); err != nil {
				panic(err)
			}
			record.After = &snapshot
		}
		out = append(out, record)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}

func (ledger *WriteLedger) Changes(taskID, nodeID string) []LaneChange {
	changes := []LaneChange{}
	for _, record := range ledger.Records(taskID, nodeID) {
		var before, after *string
		if record.Before.Exists {
			before = record.Before.Digest
		}
		if record.After != nil && record.After.Exists {
			after = record.After.Digest
		}
		if stringPtrEqual(before, after) {
			continue
		}
		status := "modified"
		if before == nil {
			status = "added"
		} else if after == nil {
			status = "deleted"
		}
		changes = append(changes, LaneChange{Path: record.Path, BeforeDigest: before, AfterDigest: after, Status: status})
	}
	return changes
}

func stringPtrEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
