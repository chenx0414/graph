package graph

import (
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
	result := w.store.Command(commandScope, requestId, commandPayload, func(tx *TaskStore) any {
		w := w.scoped(tx)
		RetireArtifact(w.store, artifactId, version, retiredAt)
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
	result := w.store.Command(commandScope, input.RequestId, commandPayload, func(tx *TaskStore) any {
		w := w.scoped(tx)
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
		RecordArtifact(w.store, ArtifactRow{
			ArtifactId: artifactId, Version: version, Scope: "project", OwnerId: task.ProjectID,
			TaskId: input.TaskId, ProjectId: task.ProjectID, Namespace: source.Namespace, Name: source.Name,
			LogicalKey: source.LogicalKey, Digest: source.Digest, ObjectPath: source.ObjectPath, Size: source.Size,
			MediaType: source.MediaType, SchemaKind: source.SchemaKind, SchemaVersion: source.SchemaVersion,
			Title: source.Title, Summary: source.Summary, Tags: source.Tags,
			ProducerNodeId: nodeID, ProducerInstanceId: instanceID, ProducerOperationId: operationID,
			ProducerActivationId: activationID, ProducerOutputVersion: outputVersion,
			Visibility: "project", Trust: string(source.Trust), State: "published",
			SupersedesArtifactId: supersedesID, SupersedesVersion: supersedesVersion,
			Metadata: metadata, CreatedAt: createdAt,
		})
		LinkArtifact(w.store, artifactId, version, "artifact", source.ArtifactId+"@"+itoa(source.Version), "promoted_from", createdAt)
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
