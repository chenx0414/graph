package graph

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
const ARTIFACT_TASK_QUOTA_BYTES = 256 * 1024 * 1024

// ARTIFACT_MAX_VERSIONS is a version-number ceiling. Retirement does not free a number.
const ARTIFACT_MAX_VERSIONS = 1000
const ARTIFACT_MAX_PUBLISHES_PER_OPERATION = 32

type ArtifactScope string
type ArtifactTrust string
type ArtifactState string

type ArtifactProducer struct {
	NodeId        string `json:"nodeId"`
	InstanceId    string `json:"instanceId"`
	OperationId   string `json:"operationId"`
	ActivationId  string `json:"activationId"`
	OutputVersion *int64 `json:"outputVersion,omitempty"`
}

type ArtifactSupersedes struct {
	ArtifactId string `json:"artifactId"`
	Version    int    `json:"version"`
}

type ArtifactRecord struct {
	ArtifactId    string              `json:"artifactId"`
	Version       int                 `json:"version"`
	Scope         ArtifactScope       `json:"scope"`
	OwnerId       string              `json:"ownerId"`
	TaskId        string              `json:"taskId"`
	ProjectId     *string             `json:"projectId"`
	Namespace     string              `json:"namespace"`
	Name          string              `json:"name"`
	LogicalKey    string              `json:"logicalKey"`
	Digest        string              `json:"digest"`
	ObjectPath    string              `json:"objectPath"`
	Size          int                 `json:"size"`
	MediaType     string              `json:"mediaType"`
	SchemaKind    *string             `json:"schemaKind"`
	SchemaVersion *int                `json:"schemaVersion"`
	Title         *string             `json:"title"`
	Summary       *string             `json:"summary"`
	Tags          []string            `json:"tags"`
	Producer      *ArtifactProducer   `json:"producer"`
	Visibility    string              `json:"visibility"`
	Trust         ArtifactTrust       `json:"trust"`
	State         ArtifactState       `json:"state"`
	Supersedes    *ArtifactSupersedes `json:"supersedes"`
	Metadata      map[string]any      `json:"metadata"`
	URI           string              `json:"uri"`
	CreatedAt     int64               `json:"createdAt"`
	RetiredAt     *int64              `json:"retiredAt"`
}

type PublishArtifactInput struct {
	TaskId          string
	Workspace       string
	Namespace       string
	Name            string
	SourcePath      string
	Content         *string
	MediaType       string
	Schema          string
	Title           string
	Summary         string
	Tags            []string
	ExpectedVersion *int64
	Producer        ArtifactProducer
	RequestId       string
	Metadata        map[string]any
}

type ArtifactQuery struct {
	ArtifactId           string
	TaskId               string
	Namespace            string
	Prefix               string
	Schema               string
	Tag                  string
	Trust                string
	IncludeRetired       bool
	LatestOnly           *bool
	Limit                *int
	Cursor               string
	IncludeTaskArtifacts bool
}

type ArtifactPage struct {
	Artifacts  []ArtifactRecord `json:"artifacts"`
	NextCursor *string          `json:"nextCursor"`
	Total      int              `json:"total"`
}

type ArtifactRead struct {
	Record    ArtifactRecord  `json:"record"`
	Text      *string         `json:"text"`
	Truncated bool            `json:"truncated"`
	Path      string          `json:"path"`
	Bytes     int             `json:"bytes"`
	Events    []ArtifactEvent `json:"events"`
}

type ArtifactEvent struct {
	Type      string `json:"type"`
	Data      any    `json:"data"`
	Timestamp int64  `json:"timestamp"`
}

type ArtifactWorkspace struct {
	store *TaskStore
	root  string
}

func NewArtifactWorkspace(store *TaskStore, root string) *ArtifactWorkspace {
	return &ArtifactWorkspace{store: store, root: root}
}

const artifactVisibleTasks = "(id=? OR (conversation_id IS NOT NULL AND conversation_id=(SELECT conversation_id FROM tasks WHERE id=?)))"

var (
	artifactSlugPattern   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)
	artifactTagPattern    = regexp.MustCompile(`^[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?$`)
	artifactSchemaPattern = regexp.MustCompile(`^([a-z][a-z0-9._-]*)@([1-9]\d*)$`)
	artifactMIMEPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`)
	artifactCodeExt       = regexp.MustCompile(`\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cc|cpp|h|java|swift|sh)$`)
)

func artifactWorkspaceWithin(root, target string) bool {
	sep := string(os.PathSeparator)
	if root == sep {
		return strings.HasPrefix(target, sep)
	}
	return target == root || strings.HasPrefix(target, root+sep)
}

func artifactRequiredText(value, field string, max int) string {
	if strings.TrimSpace(value) == "" || utf16Len(value) > max {
		Raise("invalid_artifact", field+" must be a nonempty string of at most "+itoa(max)+" characters")
	}
	return strings.TrimSpace(value)
}

func artifactOptionalText(value, field string, max int, present bool) *string {
	if !present {
		return nil
	}
	text := artifactRequiredText(value, field, max)
	return &text
}

func artifactWorkspaceSlug(value, field string) string {
	normalized := strings.ToLower(artifactRequiredText(value, field, 120))
	if !artifactSlugPattern.MatchString(normalized) {
		Raise("invalid_artifact", field+" must be a lowercase slug")
	}
	return normalized
}

func artifactParseSchema(value string, present bool) (kind *string, version *int) {
	if !present {
		return nil, nil
	}
	match := artifactSchemaPattern.FindStringSubmatch(value)
	if match == nil {
		Raise("invalid_artifact", "schema must use kind@version syntax")
	}
	number, _ := strconv.Atoi(match[2])
	return &match[1], &number
}

func artifactTag(value, field string) string {
	normalized := strings.ToLower(artifactRequiredText(value, field, 60))
	if !artifactTagPattern.MatchString(normalized) {
		Raise("invalid_artifact", field+" must be a label of letters, digits, dot, dash or underscore in any script (at most 60 characters)")
	}
	return normalized
}

func artifactNormalizeTags(value []string) []string {
	seen := map[string]bool{}
	tags := []string{}
	for _, entry := range value {
		tag := artifactTag(entry, "tag")
		if seen[tag] {
			continue
		}
		seen[tag] = true
		tags = append(tags, tag)
	}
	sort.Slice(tags, func(i, j int) bool { return lessByByteOrder(tags[i], tags[j]) })
	if len(tags) > 20 {
		Raise("invalid_artifact", "An artifact may have at most 20 tags")
	}
	return tags
}

func artifactURI(scope ArtifactScope, ownerId, namespace, name string, version int) string {
	owner := "projects"
	if scope == "task" {
		owner = "tasks"
	}
	return "graph://" + owner + "/" + encodeURIComponent(ownerId) + "/artifacts/" + encodeURIComponent(namespace) + "/" + encodeURIComponent(name) + "@" + itoa(version)
}

func artifactTruthy(value any) bool {
	if value == nil {
		return false
	}
	text, ok := value.(string)
	return !ok || text != ""
}

func artifactOptionalString(value any) *string {
	if value == nil {
		return nil
	}
	text := kernelString(value)
	if text == "" && value != "" {
		if _, ok := value.(string); !ok {
			return nil
		}
	}
	return &text
}

func artifactRecordFrom(value any) ArtifactRecord {
	if record, ok := value.(ArtifactRecord); ok {
		return record
	}
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var record ArtifactRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		panic(err)
	}
	return record
}

func artifactMapRecord(row map[string]any) ArtifactRecord {
	var producer *ArtifactProducer
	if artifactTruthy(row["producer_node_id"]) && artifactTruthy(row["producer_instance_id"]) && artifactTruthy(row["producer_operation_id"]) {
		producer = &ArtifactProducer{
			NodeId:       kernelString(row["producer_node_id"]),
			InstanceId:   kernelString(row["producer_instance_id"]),
			OperationId:  kernelString(row["producer_operation_id"]),
			ActivationId: kernelString(row["producer_activation_id"]),
		}
		if row["producer_output_version"] != nil {
			version := kernelInt(row["producer_output_version"])
			producer.OutputVersion = &version
		}
	}
	var supersedes *ArtifactSupersedes
	if artifactTruthy(row["supersedes_artifact_id"]) && row["supersedes_version"] != nil {
		supersedes = &ArtifactSupersedes{ArtifactId: kernelString(row["supersedes_artifact_id"]), Version: int(kernelInt(row["supersedes_version"]))}
	}
	tags := []string{}
	if text := kernelString(row["tags"]); text != "" {
		_ = json.Unmarshal([]byte(text), &tags)
	}
	metadata := map[string]any{}
	if text := kernelString(row["metadata"]); text != "" {
		_ = json.Unmarshal([]byte(text), &metadata)
	}
	var schemaVersion *int
	if row["schema_version"] != nil {
		version := int(kernelInt(row["schema_version"]))
		schemaVersion = &version
	}
	var retired *int64
	if row["retired_at"] != nil {
		value := kernelInt(row["retired_at"])
		retired = &value
	}
	scope := ArtifactScope(kernelString(row["scope"]))
	owner := kernelString(row["owner_id"])
	namespace := kernelString(row["namespace"])
	name := kernelString(row["name"])
	version := int(kernelInt(row["version"]))
	return ArtifactRecord{
		ArtifactId: kernelString(row["artifact_id"]), Version: version, Scope: scope, OwnerId: owner,
		TaskId: kernelString(row["task_id"]), ProjectId: artifactOptionalString(row["project_id"]),
		Namespace: namespace, Name: name, LogicalKey: kernelString(row["logical_key"]),
		Digest: kernelString(row["digest"]), ObjectPath: kernelString(row["object_path"]), Size: int(kernelInt(row["size"])),
		MediaType: kernelString(row["media_type"]), SchemaKind: artifactOptionalString(row["schema_kind"]), SchemaVersion: schemaVersion,
		Title: artifactOptionalString(row["title"]), Summary: artifactOptionalString(row["summary"]), Tags: tags,
		Producer: producer, Visibility: kernelString(row["visibility"]), Trust: ArtifactTrust(kernelString(row["trust"])),
		State: ArtifactState(kernelString(row["state"])), Supersedes: supersedes, Metadata: metadata,
		URI: artifactURI(scope, owner, namespace, name, version), CreatedAt: kernelInt(row["created_at"]), RetiredAt: retired,
	}
}

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

func (w *ArtifactWorkspace) replay(scope, requestId string, payload any) (ArtifactRecord, bool) {
	row := kernelRow(w.store.Db, "SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?", scope, requestId)
	if row == nil {
		return ArtifactRecord{}, false
	}
	if kernelString(row["payload"]) != CanonicalJSON(payload) {
		Raise("idempotency_conflict", "requestId was already used with different artifact content")
	}
	var parsed any
	if err := json.Unmarshal([]byte(kernelString(row["receipt"])), &parsed); err != nil {
		panic(err)
	}
	return artifactRecordFrom(parsed), true
}

func (w *ArtifactWorkspace) Head(taskId, logicalKey string) *ArtifactRecord {
	w.store.Task(taskId)
	row := kernelRow(w.store.Db, "SELECT * FROM artifacts WHERE scope='task' AND owner_id=? AND logical_key=? AND state='published' ORDER BY version DESC LIMIT 1", taskId, logicalKey)
	if row == nil {
		return nil
	}
	record := artifactMapRecord(row)
	return &record
}

func artifactRunGit(args ...string) (string, []byte, error) {
	cmd := exec.Command("git", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", nil, errors.New(message)
	}
	return stdout.String(), stdout.Bytes(), nil
}

func (w *ArtifactWorkspace) stableCode(input PublishArtifactInput, data []byte, metadata map[string]any, actor *string) map[string]any {
	if actor == nil {
		return metadata
	}
	fileCode := input.SourcePath != "" && artifactCodeExt.MatchString(input.SourcePath)
	_, hasKind := metadata["kind"]
	_, hasCode := metadata["code"]
	if !fileCode && (!hasKind || metadata["kind"] != "code") && !hasCode {
		return metadata
	}
	supplied := asMap(metadata["code"])
	if hasCode && supplied == nil {
		Raise("invalid_code_ref", "Code metadata requires {repository,commit,worktree?}")
	}
	repository := input.Workspace
	if text, ok := supplied["repository"].(string); ok {
		repository = text
	}
	repository = filepath.Clean(repository)
	workspace := filepath.Clean(input.Workspace)
	if repository != workspace {
		Raise("permission", "Publish code from this execution workspace; another repository requires its own authorized execution")
	}
	commitName := "HEAD"
	if text, ok := supplied["commit"].(string); ok {
		commitName = text
	}
	apply := func() map[string]any {
		commitOut, _, err := artifactRunGit("-C", repository, "rev-parse", "--verify", commitName+"^{commit}")
		if err != nil {
			panic(err)
		}
		if len(commitOut) > 4096 {
			panic(errors.New("git output exceeded maxBuffer"))
		}
		commit := strings.TrimSpace(commitOut)
		if input.SourcePath != "" {
			rootOut, _, err := artifactRunGit("-C", repository, "rev-parse", "--show-toplevel")
			if err != nil {
				panic(err)
			}
			root := strings.TrimSpace(rootOut)
			source := input.SourcePath
			if !filepath.IsAbs(source) {
				source = filepath.Join(input.Workspace, source)
			}
			source = filepath.Clean(source)
			rel, err := filepath.Rel(root, source)
			if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
				panic(errors.New("Code file is outside its repository"))
			}
			_, snapshot, err := artifactRunGit("-C", repository, "show", commit+":"+rel)
			if err != nil {
				panic(err)
			}
			if len(snapshot) > ARTIFACT_MAX_BYTES {
				panic(errors.New("git output exceeded maxBuffer"))
			}
			if !bytes.Equal(snapshot, data) {
				panic(errors.New("File differs from its commit; commit the changes before publishing"))
			}
		}
		next := map[string]any{}
		for key, value := range metadata {
			next[key] = value
		}
		next["kind"] = "code"
		next["code"] = map[string]any{"repository": repository, "commit": commit, "worktree": input.Workspace}
		return next
	}
	defer func() {
		if rec := recover(); rec != nil {
			if _, ok := rec.(*RuntimeError); ok {
				panic(rec)
			}
			message := "Code artifact requires a stable commit"
			if err, ok := rec.(error); ok {
				message = err.Error()
			}
			Raise("invalid_code_ref", message)
		}
	}()
	return apply()
}

func (w *ArtifactWorkspace) graphPublisher(taskId string, producer ArtifactProducer) *string {
	if kernelRow(w.store.Db, "SELECT 1 FROM sqlite_master WHERE name='kernel_revisions'") == nil {
		return nil
	}
	if kernelRow(w.store.Db, "SELECT 1 FROM kernel_revisions WHERE task_id=? LIMIT 1", taskId) == nil {
		return nil
	}
	execution := kernelRow(w.store.Db, "SELECT e.task_id,e.node_id,n.instance_id FROM kernel_executions e JOIN kernel_nodes n ON n.task_id=e.task_id AND n.node_id=e.node_id WHERE e.id=?", producer.OperationId)
	if execution != nil && kernelString(execution["task_id"]) == taskId && kernelString(execution["node_id"]) == producer.NodeId && kernelString(execution["instance_id"]) == producer.InstanceId {
		node := kernelString(execution["node_id"])
		return &node
	}
	main := kernelRow(w.store.Db, `SELECT 1 FROM operations o
      JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
      JOIN tasks t ON t.id=?
      LEFT JOIN kernel_graph_owners g ON g.task_id=t.id AND g.owner_task_id=o.task_id
      LEFT JOIN conversations c ON c.id=t.conversation_id AND c.anchor_task_id=o.task_id
      WHERE o.id=? AND o.node_id=? AND o.instance_id=? AND o.activation_id=?
        AND json_extract(n.spec,'$.role')='master' AND (g.task_id IS NOT NULL OR c.id IS NOT NULL)`,
		taskId, producer.OperationId, producer.NodeId, producer.InstanceId, producer.ActivationId)
	if main != nil {
		value := "main"
		return &value
	}
	Raise("permission", "Artifact publisher does not match a graph execution or its main owner")
	return nil
}

func (w *ArtifactWorkspace) assertGraphAuthor(taskId, namespace, name string, actor *string) {
	if actor == nil || *actor == "main" {
		return
	}
	first := kernelRow(w.store.Db, "SELECT producer_node_id FROM artifacts WHERE owner_id=? AND scope='task' AND namespace=? AND name=? ORDER BY version LIMIT 1", taskId, namespace, name)
	if first != nil && kernelString(first["producer_node_id"]) != *actor {
		Raise("permission", "Only the original publisher may modify this artifact; publish a separate revision")
	}
}

func artifactNullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (w *ArtifactWorkspace) Publish(input PublishArtifactInput) ArtifactRecord {
	w.store.Task(input.TaskId)
	namespace := artifactWorkspaceSlug(input.Namespace, "namespace")
	name := artifactWorkspaceSlug(input.Name, "name")
	actor := w.graphPublisher(input.TaskId, input.Producer)
	w.assertGraphAuthor(input.TaskId, namespace, name, actor)
	schemaKind, schemaVersion := artifactParseSchema(input.Schema, input.Schema != "")
	tags := artifactNormalizeTags(input.Tags)
	title := artifactOptionalText(input.Title, "title", 300, input.Title != "")
	summary := artifactOptionalText(input.Summary, "summary", 2000, input.Summary != "")
	metadata := input.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	artifactRequiredText(input.RequestId, "requestId", 200)
	commandScope := "artifact-publish:" + input.TaskId
	var expected any
	if input.ExpectedVersion != nil {
		expected = *input.ExpectedVersion
	}
	commandPayload := map[string]any{
		"namespace": namespace, "name": name, "sourcePath": artifactNullString(input.SourcePath), "content": nil,
		"mediaType": artifactNullString(input.MediaType), "schema": artifactNullString(input.Schema),
		"title": title, "summary": summary, "tags": tags, "expectedVersion": expected,
		"producer": input.Producer, "metadata": metadata,
	}
	if input.Content != nil {
		commandPayload["content"] = *input.Content
	}
	if record, ok := w.replay(commandScope, input.RequestId, commandPayload); ok {
		return record
	}
	current := w.current(input.TaskId, namespace, name)
	latest := 0
	if current != nil {
		latest = int(kernelInt(current["version"]))
	}
	expectedVersion := latest
	if input.ExpectedVersion != nil {
		expectedVersion = int(*input.ExpectedVersion)
	}
	if input.ExpectedVersion != nil && !jsSafeInteger(*input.ExpectedVersion) || expectedVersion < 0 {
		Raise("invalid_artifact", "expectedVersion must be a nonnegative integer")
	}
	if expectedVersion != latest {
		Raise("artifact_conflict", "Artifact head changed: expected version "+itoa(expectedVersion)+", found "+itoa(latest))
	}
	if latest >= ARTIFACT_MAX_VERSIONS {
		Raise("artifact_quota", "Artifact may have at most "+itoa(ARTIFACT_MAX_VERSIONS)+" versions")
	}
	if w.operationPublishes(input.Producer.OperationId) >= ARTIFACT_MAX_PUBLISHES_PER_OPERATION {
		Raise("artifact_quota", "An operation may publish at most "+itoa(ARTIFACT_MAX_PUBLISHES_PER_OPERATION)+" artifacts")
	}
	data, digest, filename := w.source(input)
	metadata = w.stableCode(input, data, metadata, actor)
	if actor != nil && *actor != "main" {
		next := map[string]any{}
		for key, value := range metadata {
			next[key] = value
		}
		var subgraph any
		if strings.Contains(*actor, "/") {
			subgraph = (*actor)[:strings.LastIndex(*actor, "/")]
		}
		next["subgraphPath"] = subgraph
		metadata = next
	}
	if w.taskBytes(input.TaskId)+int64(len(data)) > ARTIFACT_TASK_QUOTA_BYTES {
		Raise("artifact_quota", "Task artifact workspace exceeds "+itoa(ARTIFACT_TASK_QUOTA_BYTES)+" bytes")
	}
	root := w.ensureRoot()
	relative := w.ensureObject(root, digest, data)
	result := w.store.Command(commandScope, input.RequestId, commandPayload, func() any {
		w.assertGraphAuthor(input.TaskId, namespace, name, actor)
		fresh := w.current(input.TaskId, namespace, name)
		freshLatest := 0
		var freshID string
		if fresh != nil {
			freshLatest = int(kernelInt(fresh["version"]))
			freshID = kernelString(fresh["artifact_id"])
		}
		if freshLatest != expectedVersion {
			Raise("artifact_conflict", "Artifact head changed: expected version "+itoa(expectedVersion)+", found "+itoa(freshLatest))
		}
		if freshLatest >= ARTIFACT_MAX_VERSIONS {
			Raise("artifact_quota", "Artifact may have at most "+itoa(ARTIFACT_MAX_VERSIONS)+" versions")
		}
		if w.operationPublishes(input.Producer.OperationId) >= ARTIFACT_MAX_PUBLISHES_PER_OPERATION {
			Raise("artifact_quota", "An operation may publish at most "+itoa(ARTIFACT_MAX_PUBLISHES_PER_OPERATION)+" artifacts")
		}
		if w.taskBytes(input.TaskId)+int64(len(data)) > ARTIFACT_TASK_QUOTA_BYTES {
			Raise("artifact_quota", "Task artifact workspace exceeds "+itoa(ARTIFACT_TASK_QUOTA_BYTES)+" bytes")
		}
		version := freshLatest + 1
		artifactId := freshID
		if artifactId == "" {
			artifactId = newUUID()
		}
		createdAt := NowMillis()
		var supersedes *ArtifactSupersedes
		if freshLatest != 0 {
			supersedes = &ArtifactSupersedes{ArtifactId: artifactId, Version: freshLatest}
		}
		record := ArtifactRecord{
			ArtifactId: artifactId, Version: version, Scope: "task", OwnerId: input.TaskId, TaskId: input.TaskId,
			ProjectId: nil, Namespace: namespace, Name: name, LogicalKey: namespace + "/" + name, Digest: digest,
			ObjectPath: relative, Size: len(data), MediaType: artifactContentMediaType(filename, input.MediaType),
			SchemaKind: schemaKind, SchemaVersion: schemaVersion, Title: title, Summary: summary, Tags: tags,
			Producer: &input.Producer, Visibility: "task", Trust: "unverified", State: "published",
			Supersedes: supersedes, Metadata: metadata, URI: artifactURI("task", input.TaskId, namespace, name, version),
			CreatedAt: createdAt, RetiredAt: nil,
		}
		var outputVersion any
		if input.Producer.OutputVersion != nil {
			outputVersion = *input.Producer.OutputVersion
		}
		var supersedesID, supersedesVersion any
		if supersedes != nil {
			supersedesID = supersedes.ArtifactId
			supersedesVersion = supersedes.Version
		}
		kernelExec(w.store.Db, `INSERT INTO artifacts(
        artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,digest,object_path,size,
        media_type,schema_kind,schema_version,title,summary,tags,producer_node_id,producer_instance_id,
        producer_operation_id,producer_activation_id,producer_output_version,visibility,trust,state,
        supersedes_artifact_id,supersedes_version,metadata,created_at,retired_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			record.ArtifactId, record.Version, string(record.Scope), record.OwnerId, record.TaskId, nil, record.Namespace, record.Name,
			record.LogicalKey, record.Digest, record.ObjectPath, record.Size, record.MediaType, record.SchemaKind, record.SchemaVersion,
			record.Title, record.Summary, CanonicalJSON(record.Tags), input.Producer.NodeId, input.Producer.InstanceId,
			input.Producer.OperationId, input.Producer.ActivationId, outputVersion, record.Visibility, string(record.Trust), string(record.State),
			supersedesID, supersedesVersion, CanonicalJSON(record.Metadata), record.CreatedAt, nil)
		kernelExec(w.store.Db, `INSERT OR IGNORE INTO artifact_links(id,artifact_id,version,subject_kind,subject_id,relation,created_at)
        VALUES(?,?,?,?,?,?,?)`, newUUID(), artifactId, version, "operation", input.Producer.OperationId, "produced_by", createdAt)
		w.artifactEvent(input.TaskId, artifactId, version, "artifact.published", map[string]any{
			"artifactId": artifactId, "version": version, "namespace": namespace, "name": name, "digest": digest, "size": len(data),
		})
		return record
	})
	record := artifactRecordFrom(result)
	w.store.Event(input.TaskId, "artifact.published", map[string]any{
		"artifactId": record.ArtifactId, "version": record.Version, "namespace": namespace, "name": name, "digest": digest, "size": len(data),
	})
	return record
}

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

func (w *ArtifactWorkspace) Retire(taskId, artifactId string, version int, reason, requestId string, actor any) ArtifactRecord {
	record := w.Get(taskId, artifactId, &version, "")
	ownerTaskId := taskId
	if record.Scope == "task" {
		ownerTaskId = record.OwnerId
	}
	v2 := kernelRow(w.store.Db, "SELECT 1 FROM sqlite_master WHERE name='kernel_revisions'") != nil &&
		kernelRow(w.store.Db, "SELECT 1 FROM kernel_revisions WHERE task_id=? LIMIT 1", ownerTaskId) != nil
	targetTaskId := taskId
	if v2 {
		targetTaskId = ownerTaskId
		if actor == nil {
			Raise("permission", "Artifact retirement requires the publisher or main owner")
		}
		var publisher *string
		if actor == "main" {
			value := "main"
			publisher = &value
		} else if producer, ok := actor.(ArtifactProducer); ok {
			publisher = w.graphPublisher(targetTaskId, producer)
		} else {
			Raise("permission", "Artifact retirement requires the publisher or main owner")
		}
		w.assertGraphAuthor(targetTaskId, record.Namespace, record.Name, publisher)
	}
	if record.State == "retired" {
		return record
	}
	commandScope := "artifact-retire:" + targetTaskId
	commandPayload := map[string]any{"artifactId": artifactId, "version": version, "reason": artifactRequiredText(reason, "reason", 1000)}
	artifactRequiredText(requestId, "requestId", 200)
	if replayed, ok := w.replay(commandScope, requestId, commandPayload); ok {
		return replayed
	}
	retiredAt := NowMillis()
	result := w.store.Command(commandScope, requestId, commandPayload, func() any {
		kernelExec(w.store.Db, "UPDATE artifacts SET state='retired',retired_at=? WHERE artifact_id=? AND version=?", retiredAt, artifactId, version)
		w.artifactEvent(targetTaskId, record.ArtifactId, record.Version, "artifact.retired", commandPayload)
		record.State = "retired"
		record.RetiredAt = &retiredAt
		return record
	})
	retired := artifactRecordFrom(result)
	w.store.Event(targetTaskId, "artifact.retired", commandPayload)
	return retired
}

type ArtifactPromoteInput struct {
	TaskId     string
	ArtifactId string
	Version    int
	RequestId  string
	PromotedBy string
}

func (w *ArtifactWorkspace) Promote(input ArtifactPromoteInput) ArtifactRecord {
	artifactRequiredText(input.RequestId, "requestId", 200)
	task := w.store.Task(input.TaskId)
	if task.ProjectID == "" {
		Raise("invalid_artifact", "Cross-task promotion requires a project-bound task")
	}
	source := w.Get(input.TaskId, input.ArtifactId, &input.Version, "")
	commandScope := "artifact-promote:" + input.TaskId
	commandPayload := map[string]any{"artifactId": input.ArtifactId, "version": input.Version, "promotedBy": input.PromotedBy}
	if replayed, ok := w.replay(commandScope, input.RequestId, commandPayload); ok {
		return replayed
	}
	result := w.store.Command(commandScope, input.RequestId, commandPayload, func() any {
		latest := kernelRow(w.store.Db, `SELECT artifact_id,version FROM artifacts
        WHERE scope='project' AND owner_id=? AND namespace=? AND name=?
        ORDER BY version DESC LIMIT 1`, task.ProjectID, source.Namespace, source.Name)
		artifactId := newUUID()
		version := 1
		if latest != nil {
			artifactId = kernelString(latest["artifact_id"])
			version = int(kernelInt(latest["version"])) + 1
		}
		createdAt := NowMillis()
		metadata := map[string]any{}
		for key, value := range source.Metadata {
			metadata[key] = value
		}
		metadata["promotedFrom"] = source.URI
		metadata["promotedBy"] = input.PromotedBy
		var nodeID, instanceID, operationID, activationID, outputVersion any
		if source.Producer != nil {
			nodeID = source.Producer.NodeId
			instanceID = source.Producer.InstanceId
			operationID = source.Producer.OperationId
			activationID = source.Producer.ActivationId
			if source.Producer.OutputVersion != nil {
				outputVersion = *source.Producer.OutputVersion
			}
		}
		var supersedesID, supersedesVersion any
		var supersedes *ArtifactSupersedes
		if latest != nil {
			supersedesID = kernelString(latest["artifact_id"])
			supersedesVersion = int(kernelInt(latest["version"]))
			supersedes = &ArtifactSupersedes{ArtifactId: kernelString(latest["artifact_id"]), Version: int(kernelInt(latest["version"]))}
		}
		kernelExec(w.store.Db, `INSERT INTO artifacts(
        artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,digest,object_path,size,
        media_type,schema_kind,schema_version,title,summary,tags,producer_node_id,producer_instance_id,
        producer_operation_id,producer_activation_id,producer_output_version,visibility,trust,state,
        supersedes_artifact_id,supersedes_version,metadata,created_at,retired_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			artifactId, version, "project", task.ProjectID, input.TaskId, task.ProjectID, source.Namespace, source.Name,
			source.LogicalKey, source.Digest, source.ObjectPath, source.Size, source.MediaType, source.SchemaKind,
			source.SchemaVersion, source.Title, source.Summary, CanonicalJSON(source.Tags), nodeID, instanceID,
			operationID, activationID, outputVersion, "project", string(source.Trust), "published",
			supersedesID, supersedesVersion, CanonicalJSON(metadata), createdAt, nil)
		kernelExec(w.store.Db, `INSERT OR IGNORE INTO artifact_links(id,artifact_id,version,subject_kind,subject_id,relation,created_at)
        VALUES(?,?,?,?,?,?,?)`, newUUID(), artifactId, version, "artifact", source.ArtifactId+"@"+itoa(source.Version), "promoted_from", createdAt)
		w.artifactEvent(input.TaskId, artifactId, version, "artifact.promoted", map[string]any{
			"artifactId": artifactId, "version": version, "sourceArtifactId": source.ArtifactId, "sourceVersion": source.Version,
		})
		project := task.ProjectID
		record := source
		record.ArtifactId = artifactId
		record.Version = version
		record.Scope = "project"
		record.OwnerId = project
		record.ProjectId = &project
		record.Visibility = "project"
		record.Supersedes = supersedes
		record.Metadata = metadata
		record.URI = artifactURI("project", project, source.Namespace, source.Name, version)
		record.CreatedAt = createdAt
		record.RetiredAt = nil
		record.State = "published"
		return record
	})
	record := artifactRecordFrom(result)
	w.store.Event(input.TaskId, "artifact.promoted", map[string]any{
		"artifactId": record.ArtifactId, "version": record.Version, "sourceArtifactId": source.ArtifactId, "sourceVersion": source.Version,
	})
	return record
}

func (w *ArtifactWorkspace) GC(retentionMs ...int64) map[string]int {
	retention := int64(7 * 24 * 60 * 60 * 1000)
	if len(retentionMs) > 0 {
		retention = retentionMs[0]
	}
	root := w.ensureRoot()
	referenced := map[string]bool{}
	for _, row := range kernelRows(w.store.Db, "SELECT DISTINCT digest FROM artifacts") {
		referenced[kernelString(row["digest"])] = true
	}
	removed := 0
	objects := filepath.Join(root, "objects", "sha256")
	prefixes, err := os.ReadDir(objects)
	if err != nil {
		prefixes = nil
	}
	cutoff := NowMillis() - retention
	for _, prefix := range prefixes {
		directory := filepath.Join(objects, prefix.Name())
		entries, err := os.ReadDir(directory)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if referenced[entry.Name()] {
				continue
			}
			path := filepath.Join(directory, entry.Name())
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() || info.ModTime().UnixMilli() > cutoff {
				continue
			}
			if err := os.Remove(path); err != nil {
				panic(err)
			}
			removed++
		}
	}
	return map[string]int{"removed": removed}
}
