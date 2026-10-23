package graph

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
