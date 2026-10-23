package graph

import (
	"encoding/json"
)

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
