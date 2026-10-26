package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func artifactContentMediaType(path, supplied string) string {
	if supplied != "" {
		value := strings.ToLower(strings.TrimSpace(supplied))
		if !artifactMIMEPattern.MatchString(value) {
			Raise("invalid_artifact", "mediaType must be a valid MIME type")
		}
		return value
	}
	base := filepath.Base(path)
	extension := ""
	if parts := strings.Split(base, "."); len(parts) > 0 {
		extension = strings.ToLower(parts[len(parts)-1])
	}
	plain := map[string]bool{"ts": true, "tsx": true, "js": true, "jsx": true, "mjs": true, "cjs": true, "py": true, "rs": true, "go": true, "c": true, "cc": true, "cpp": true, "h": true, "java": true, "swift": true, "sh": true}
	if extension != "" && plain[extension] {
		return "text/plain"
	}
	known := map[string]string{
		"json": "application/json", "jsonl": "application/x-ndjson", "md": "text/markdown", "markdown": "text/markdown",
		"txt": "text/plain", "csv": "text/csv", "html": "text/html", "xml": "application/xml", "yaml": "application/yaml",
		"yml": "application/yaml", "pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
		"gif": "image/gif", "svg": "image/svg+xml",
	}
	if value, ok := known[extension]; ok {
		return value
	}
	return "application/octet-stream"
}

func artifactObjectRelative(digest string) string {
	return filepath.Join("objects", "sha256", digest[:2], digest)
}

func (w *ArtifactWorkspace) ensureRoot() string {
	if err := os.MkdirAll(w.root, 0o700); err != nil {
		panic(err)
	}
	root, err := filepath.EvalSymlinks(w.root)
	if err != nil {
		panic(err)
	}
	return root
}

func artifactNlink(info os.FileInfo) uint64 {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 1
	}
	return uint64(stat.Nlink)
}

func (w *ArtifactWorkspace) source(input PublishArtifactInput) (data []byte, digest, filename string) {
	hasPath := input.SourcePath != ""
	hasContent := input.Content != nil
	if hasPath == hasContent {
		Raise("invalid_artifact", "Exactly one of sourcePath or content is required")
	}
	if hasContent {
		data = []byte(*input.Content)
		if len(data) > ARTIFACT_MAX_BYTES {
			Raise("artifact_quota", "Artifact exceeds the "+itoa(ARTIFACT_MAX_BYTES)+" byte limit")
		}
		sum := sha256.Sum256(data)
		return data, hex.EncodeToString(sum[:]), input.Name + ".txt"
	}
	workspace, err := filepath.EvalSymlinks(input.Workspace)
	if err != nil {
		panic(err)
	}
	candidate := input.SourcePath
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(workspace, candidate)
	}
	candidate = filepath.Clean(candidate)
	info, err := os.Lstat(candidate)
	if err != nil {
		Raise("invalid_artifact", "sourcePath does not exist")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		Raise("invalid_artifact", "sourcePath may not be a symbolic link")
	}
	if !info.Mode().IsRegular() {
		Raise("invalid_artifact", "sourcePath must be a regular file")
	}
	if artifactNlink(info) > 1 {
		Raise("invalid_artifact", "sourcePath may not be a multiply-linked file")
	}
	canonical, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		panic(err)
	}
	if !artifactWorkspaceWithin(workspace, canonical) {
		Raise("invalid_artifact", "sourcePath escaped the operation workspace: write the report inside your work copy and publish that path, or pass its bytes as content")
	}
	if info.Size() > ARTIFACT_MAX_BYTES {
		Raise("artifact_quota", "Artifact exceeds the "+itoa(ARTIFACT_MAX_BYTES)+" byte limit")
	}
	data, err = os.ReadFile(canonical)
	if err != nil {
		panic(err)
	}
	if len(data) > ARTIFACT_MAX_BYTES {
		Raise("artifact_quota", "Artifact exceeds the "+itoa(ARTIFACT_MAX_BYTES)+" byte limit")
	}
	sum := sha256.Sum256(data)
	return data, hex.EncodeToString(sum[:]), filepath.Base(canonical)
}

func (w *ArtifactWorkspace) ensureObject(root, digest string, data []byte) string {
	relative := artifactObjectRelative(digest)
	target := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		panic(err)
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			panic(err)
		}
		existing, statErr := os.Stat(target)
		if statErr != nil || !existing.Mode().IsRegular() || existing.Size() != int64(len(data)) {
			Raise("artifact_integrity", "Existing object does not match its digest path")
		}
	} else {
		if _, err := file.Write(data); err != nil {
			_ = file.Close()
			panic(err)
		}
		if err := file.Sync(); err != nil {
			_ = file.Close()
			panic(err)
		}
		_ = file.Close()
	}
	if err := os.Chmod(target, 0o400); err != nil {
		panic(err)
	}
	return relative
}

func (w *ArtifactWorkspace) assertScope(record ArtifactRecord, taskId string) ArtifactRecord {
	task := w.store.Task(taskId)
	visible := false
	if record.Scope == "task" {
		visible = kernelRow(w.store.Db, "SELECT 1 FROM tasks WHERE "+artifactVisibleTasks+" AND id=?", taskId, taskId, record.OwnerId) != nil
	} else {
		visible = task.ProjectID != "" && record.ProjectId != nil && *record.ProjectId == task.ProjectID
	}
	if !visible {
		Raise("not_found", "Artifact not found in this task workspace")
	}
	return record
}

func (w *ArtifactWorkspace) current(taskId, namespace, name string) map[string]any {
	return kernelRow(w.store.Db, `SELECT artifact_id,version FROM artifacts
      WHERE scope='task' AND owner_id=? AND namespace=? AND name=?
      ORDER BY version DESC LIMIT 1`, taskId, namespace, name)
}

func (w *ArtifactWorkspace) artifactEvent(taskId string, artifactId string, version int, eventType string, data any) {
	kernelExec(w.store.Db, `INSERT INTO artifact_events(task_id,artifact_id,version,type,data,timestamp)
      VALUES(?,?,?,?,?,?)`, taskId, artifactId, version, eventType, CanonicalJSON(data), NowMillis())
}

func (w *ArtifactWorkspace) taskBytes(taskId string) int64 {
	row := kernelRow(w.store.Db, "SELECT COALESCE(SUM(size),0) AS bytes FROM artifacts WHERE task_id=?", taskId)
	return kernelInt(row["bytes"])
}

func (w *ArtifactWorkspace) operationPublishes(operationId string) int64 {
	row := kernelRow(w.store.Db, "SELECT COUNT(*) AS count FROM artifacts WHERE producer_operation_id=?", operationId)
	return kernelInt(row["count"])
}
