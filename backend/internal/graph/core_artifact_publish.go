package graph

import (
	"bytes"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
)

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
		RecordArtifact(w.store, ArtifactRow{
			ArtifactId: record.ArtifactId, Version: record.Version, Scope: string(record.Scope), OwnerId: record.OwnerId,
			TaskId: record.TaskId, ProjectId: nil, Namespace: record.Namespace, Name: record.Name,
			LogicalKey: record.LogicalKey, Digest: record.Digest, ObjectPath: record.ObjectPath, Size: record.Size,
			MediaType: record.MediaType, SchemaKind: record.SchemaKind, SchemaVersion: record.SchemaVersion,
			Title: record.Title, Summary: record.Summary, Tags: record.Tags,
			ProducerNodeId: input.Producer.NodeId, ProducerInstanceId: input.Producer.InstanceId,
			ProducerOperationId: input.Producer.OperationId, ProducerActivationId: input.Producer.ActivationId,
			ProducerOutputVersion: outputVersion, Visibility: record.Visibility, Trust: string(record.Trust), State: string(record.State),
			SupersedesArtifactId: supersedesID, SupersedesVersion: supersedesVersion,
			Metadata: record.Metadata, CreatedAt: record.CreatedAt,
		})
		LinkArtifact(w.store, artifactId, version, "operation", input.Producer.OperationId, "produced_by", createdAt)
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
