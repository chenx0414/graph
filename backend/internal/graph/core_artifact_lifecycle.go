package graph

import (
	"os"
	"path/filepath"
)

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
