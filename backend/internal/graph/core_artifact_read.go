package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func (w *ArtifactWorkspace) ListProject(projectId string, input ArtifactQuery) ArtifactPage {
	if input.IncludeTaskArtifacts {
		return w.page([]string{"((scope='project' AND owner_id=?) OR (scope='task' AND owner_id IN (SELECT id FROM tasks WHERE project_id=?)))"}, []any{projectId, projectId}, input)
	}
	return w.page([]string{"(scope='project' AND owner_id=?)"}, []any{projectId}, input)
}

func (w *ArtifactWorkspace) List(input ArtifactQuery) ArtifactPage {
	task := w.store.Task(input.TaskId)
	condition := "((scope='task' AND owner_id IN (SELECT id FROM tasks WHERE " + artifactVisibleTasks + "))"
	params := []any{input.TaskId, input.TaskId}
	if task.ProjectID != "" {
		condition += " OR (scope='project' AND project_id=?)"
		params = append(params, task.ProjectID)
	}
	condition += ")"
	return w.page([]string{condition}, params, input)
}

func (w *ArtifactWorkspace) ListGraph(graphId string, input ArtifactQuery) ArtifactPage {
	w.store.Task(graphId)
	return w.page([]string{"scope='task' AND owner_id=?"}, []any{graphId}, input)
}

func (w *ArtifactWorkspace) page(conditions []string, params []any, input ArtifactQuery) ArtifactPage {
	conditions = append([]string{}, conditions...)
	params = append([]any{}, params...)
	if input.ArtifactId != "" {
		conditions = append(conditions, "artifact_id=?")
		params = append(params, input.ArtifactId)
	}
	if input.Namespace != "" {
		conditions = append(conditions, "namespace=?")
		params = append(params, artifactWorkspaceSlug(input.Namespace, "namespace"))
	}
	if input.Prefix != "" {
		conditions = append(conditions, "name LIKE ?")
		params = append(params, artifactWorkspaceSlug(input.Prefix, "prefix")+"%")
	}
	if input.Schema != "" {
		kind, version := artifactParseSchema(input.Schema, true)
		conditions = append(conditions, "schema_kind=? AND schema_version=?")
		params = append(params, *kind, *version)
	}
	if input.Tag != "" {
		conditions = append(conditions, "EXISTS (SELECT 1 FROM json_each(artifacts.tags) WHERE value=?)")
		params = append(params, artifactTag(input.Tag, "tag"))
	}
	if input.Trust != "" {
		conditions = append(conditions, "trust=?")
		params = append(params, input.Trust)
	}
	where := strings.Join(conditions, " AND ")
	limit := 100
	if input.Limit != nil {
		limit = *input.Limit
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	offset := 0
	if input.Cursor != "" {
		parsed, err := strconv.ParseInt(input.Cursor, 10, 64)
		if err == nil && parsed > 0 {
			offset = int(parsed)
		}
	}
	ranked := "SELECT * FROM artifacts WHERE " + where
	if input.LatestOnly == nil || *input.LatestOnly {
		ranked = `SELECT * FROM (
          SELECT *,ROW_NUMBER() OVER (
            PARTITION BY scope,owner_id,namespace,name ORDER BY version DESC
          ) AS artifact_rank
          FROM artifacts WHERE ` + where + `
        ) WHERE artifact_rank=1`
	}
	visible := ranked
	if !input.IncludeRetired {
		visible = "SELECT * FROM (" + ranked + ") WHERE state='published'"
	}
	totalRow := kernelRow(w.store.Db, "SELECT COUNT(*) AS count FROM ("+visible+")", params...)
	rows := kernelRows(w.store.Db, visible+" ORDER BY created_at DESC,artifact_id,version DESC LIMIT ? OFFSET ?", append(params, limit, offset)...)
	artifacts := make([]ArtifactRecord, 0, len(rows))
	for _, row := range rows {
		artifacts = append(artifacts, artifactMapRecord(row))
	}
	total := int(kernelInt(totalRow["count"]))
	var next *string
	if offset+len(rows) < total {
		text := itoa(offset + len(rows))
		next = &text
	}
	return ArtifactPage{Artifacts: artifacts, NextCursor: next, Total: total}
}

func (w *ArtifactWorkspace) Get(taskId, artifactId string, version *int, scope string) ArtifactRecord {
	var row map[string]any
	if version == nil {
		if scope == "" {
			row = kernelRow(w.store.Db, "SELECT * FROM artifacts WHERE artifact_id=? ORDER BY version DESC LIMIT 1", artifactId)
		} else {
			row = kernelRow(w.store.Db, "SELECT * FROM artifacts WHERE artifact_id=? AND scope=? ORDER BY version DESC LIMIT 1", artifactId, scope)
		}
	} else if scope == "" {
		row = kernelRow(w.store.Db, "SELECT * FROM artifacts WHERE artifact_id=? AND version=? ORDER BY CASE scope WHEN 'task' THEN 0 ELSE 1 END LIMIT 1", artifactId, *version)
	} else {
		row = kernelRow(w.store.Db, "SELECT * FROM artifacts WHERE artifact_id=? AND version=? AND scope=? ORDER BY CASE scope WHEN 'task' THEN 0 ELSE 1 END LIMIT 1", artifactId, *version, scope)
	}
	if row == nil {
		Raise("not_found", "Artifact not found")
	}
	return w.assertScope(artifactMapRecord(row), taskId)
}

func (w *ArtifactWorkspace) ReadVerifiedContent(taskId, artifactId string, version int, maxBytes ...int) []byte {
	limit := 1_048_576
	if len(maxBytes) > 0 {
		limit = maxBytes[0]
	}
	if !jsSafeInteger(limit) || limit < 1 || limit > 4*1024*1024 {
		Raise("invalid_artifact", "Evidence limit must be between 1 byte and 4 MiB")
	}
	record := w.Get(taskId, artifactId, &version, "")
	root, err := filepath.EvalSymlinks(w.root)
	if err != nil {
		panic(err)
	}
	path := filepath.Clean(filepath.Join(root, record.ObjectPath))
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || !artifactWorkspaceWithin(root, path) || !artifactWorkspaceWithin(root, canonical) {
		Raise("artifact_integrity", "Artifact object path escaped the workspace root")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		panic(err)
	}
	defer syscall.Close(fd)
	var info syscall.Stat_t
	if err := syscall.Fstat(fd, &info); err != nil {
		panic(err)
	}
	if info.Mode&syscall.S_IFREG == 0 || info.Size > int64(limit) || info.Size != int64(record.Size) {
		Raise("artifact_integrity", "Evidence bytes are unavailable within the limit")
	}
	buffer := make([]byte, limit+1)
	size := 0
	for size < len(buffer) {
		count, err := syscall.Read(fd, buffer[size:])
		if count == 0 || err != nil {
			break
		}
		size += count
	}
	data := buffer[:size]
	sum := sha256.Sum256(data)
	if size != record.Size || size > limit || hex.EncodeToString(sum[:]) != record.Digest {
		Raise("artifact_integrity", "Evidence no longer matches its published version")
	}
	return data
}

func (w *ArtifactWorkspace) Read(taskId, artifactId string, version int, maxBytes int, scope string) ArtifactRead {
	if maxBytes == 0 {
		maxBytes = 262144
	}
	record := w.Get(taskId, artifactId, &version, scope)
	if !jsSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4*1024*1024 {
		Raise("invalid_artifact", "maxBytes must be between 1 byte and 4 MiB")
	}
	root := w.ensureRoot()
	path := filepath.Clean(filepath.Join(root, record.ObjectPath))
	if !artifactWorkspaceWithin(root, path) {
		Raise("artifact_integrity", "Artifact object path escaped the workspace root")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != record.Digest || len(data) != record.Size {
		Raise("artifact_integrity", "Artifact content no longer matches its published digest")
	}
	w.store.Transaction(func() any {
		w.artifactEvent(taskId, record.ArtifactId, record.Version, "artifact.accessed", map[string]any{
			"artifactId": record.ArtifactId, "version": record.Version,
		})
		return nil
	})
	rows := kernelRows(w.store.Db, `SELECT type,data,timestamp FROM artifact_events
      WHERE artifact_id=? AND version=? ORDER BY cursor DESC LIMIT 20`, record.ArtifactId, record.Version)
	events := make([]ArtifactEvent, 0, len(rows))
	for _, event := range rows {
		var parsed any
		if err := json.Unmarshal([]byte(kernelString(event["data"])), &parsed); err != nil {
			panic(err)
		}
		events = append(events, ArtifactEvent{Type: kernelString(event["type"]), Data: parsed, Timestamp: kernelInt(event["timestamp"])})
	}
	textLike := strings.HasPrefix(record.MediaType, "text/") || record.MediaType == "application/json" || record.MediaType == "application/xml" || record.MediaType == "application/yaml" || record.MediaType == "application/x-ndjson"
	var text *string
	if textLike && len(data) <= maxBytes {
		value := string(data)
		text = &value
	}
	return ArtifactRead{Record: record, Text: text, Truncated: textLike && len(data) > maxBytes, Path: path, Bytes: len(data), Events: events}
}
