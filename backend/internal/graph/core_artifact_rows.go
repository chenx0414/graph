package graph

type ArtifactRow struct {
	ArtifactId            string
	Version               int
	Scope                 string
	OwnerId               string
	TaskId                string
	ProjectId             any
	Namespace             string
	Name                  string
	LogicalKey            string
	Digest                string
	ObjectPath            string
	Size                  int
	MediaType             string
	SchemaKind            any
	SchemaVersion         any
	Title                 any
	Summary               any
	Tags                  []string
	ProducerNodeId        any
	ProducerInstanceId    any
	ProducerOperationId   any
	ProducerActivationId  any
	ProducerOutputVersion any
	Visibility            string
	Trust                 string
	State                 string
	SupersedesArtifactId  any
	SupersedesVersion     any
	Metadata              map[string]any
	CreatedAt             int64
	RetiredAt             any
}

func RecordArtifact(store *TaskStore, row ArtifactRow) {
	kernelExec(store.Db, `INSERT INTO artifacts(
        artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,digest,object_path,size,
        media_type,schema_kind,schema_version,title,summary,tags,producer_node_id,producer_instance_id,
        producer_operation_id,producer_activation_id,producer_output_version,visibility,trust,state,
        supersedes_artifact_id,supersedes_version,metadata,created_at,retired_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		row.ArtifactId, row.Version, row.Scope, row.OwnerId, row.TaskId, row.ProjectId, row.Namespace, row.Name,
		row.LogicalKey, row.Digest, row.ObjectPath, row.Size, row.MediaType, row.SchemaKind, row.SchemaVersion,
		row.Title, row.Summary, CanonicalJSON(row.Tags), row.ProducerNodeId, row.ProducerInstanceId,
		row.ProducerOperationId, row.ProducerActivationId, row.ProducerOutputVersion, row.Visibility, row.Trust, row.State,
		row.SupersedesArtifactId, row.SupersedesVersion, CanonicalJSON(row.Metadata), row.CreatedAt, row.RetiredAt)
}

func RetireArtifact(store *TaskStore, artifactID string, version int, retiredAt int64) {
	kernelExec(store.Db, "UPDATE artifacts SET state='retired',retired_at=? WHERE artifact_id=? AND version=?", retiredAt, artifactID, version)
}

func LinkArtifact(store *TaskStore, artifactID string, version int, subjectKind, subjectID, relation string, at int64) {
	kernelExec(store.Db, `INSERT OR IGNORE INTO artifact_links(id,artifact_id,version,subject_kind,subject_id,relation,created_at)
        VALUES(?,?,?,?,?,?,?)`, newUUID(), artifactID, version, subjectKind, subjectID, relation, at)
}
