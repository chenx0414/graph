package graph

// GraphManagement is the main-agent management contract. Every target remains
// in the owner's conversation.
type GraphManagement interface {
	GraphCreate(input GraphCreateInput) any
	GraphPatch(input GraphPatchInput) any
	GraphInspect(input GraphInspectInput) any
	GraphControl(input GraphControlInput) any
	GraphSend(input GraphSendInput) any
	// HarnessFriction records friction the project met but has not solved.
	HarnessFriction(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessFrictionInput) HarnessFrictionResult
	// HarnessCompare reads the behavioral contrast of the candidates of one
	// task. It belongs to the graph facts it reads, so it lives here.
	HarnessCompare(input HarnessCompareInput) HarnessComparison
	// HarnessExperience reads the lessons earlier tasks adopted per domain.
	HarnessExperience(input HarnessExperienceInput) HarnessExperienceResult
	// HarnessDecision records the adopted candidate and the lesson it taught.
	HarnessDecision(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult
	// HarnessProbe runs one task under several harnesses and contrasts them.
	HarnessProbe(input HarnessProbeInput) HarnessProbeResult
	// HarnessEvidence reads the evidence of the caller's own run: the
	// trajectory, the tool failures, the blocked work and the usage.
	HarnessEvidence(input HarnessEvidenceInput) HarnessEvidenceResult
}

// GraphCreateInput creates an independently owned graph.
type GraphCreateInput struct {
	Definition   any
	TargetBranch *string
	RequestId    *string
}

// GraphPatchInput publishes a new revision of a graph.
type GraphPatchInput struct {
	GraphId      string
	BaseRevision int
	Changes      PatchChange
}

// GraphInspectInput reads a graph's facts.
type GraphInspectInput struct {
	GraphId      string
	Query        *string
	Id           *string
	DeliveryId   *string
	TransitionId *string
	After        *int
	Limit        *int
}

// GraphControlInput drives a graph's execution controls.
type GraphControlInput struct {
	GraphId     string
	Action      string
	NodeId      *string
	ModuleId    *string
	Seq         *int
	OperationId *string
	CallId      *string
	Usage       *TokenUsage
}

// GraphSendInput delivers a public input or a chat message.
type GraphSendInput struct {
	GraphId string
	NodeId  *string
	Input   *string
	Value   any
	Text    *string
}

// GraphCreateResult is the graph a create returns.
type GraphCreateResult struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   int             `json:"revision"`
	RequestId  string          `json:"requestId"`
	Replayed   bool            `json:"replayed"`
}

// GraphCreateBlocked is the result of a create whose Git preparation failed.
type GraphCreateBlocked struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   int             `json:"revision"`
	RequestId  string          `json:"requestId"`
	State      string          `json:"state"`
	Reason     string          `json:"reason"`
}

// graphManagementService is the GraphManagement bound to one owner task.
type graphManagementService struct {
	kernel      *KernelStore
	ownerTaskId string
	prepare     func(graphId string, branch string)
	artifacts   *ArtifactWorkspace
}

// NewGraphManagement binds the management surface to one owner task.
// The TypeScript export was graphManagement; the interface kept the
// GraphManagement name, so the factory follows the constructor spelling.
func NewGraphManagement(kernel *KernelStore, ownerTaskId string, prepare func(graphId string, branch string), artifacts *ArtifactWorkspace) GraphManagement {
	return &graphManagementService{kernel: kernel, ownerTaskId: ownerTaskId, prepare: prepare, artifacts: artifacts}
}

func (service *graphManagementService) owner() TaskRow {
	return service.kernel.Store.Task(service.ownerTaskId)
}

func (service *graphManagementService) runtime(graphId string) *GraphRuntime {
	target := service.kernel.Store.Task(graphId)
	bindingOwner, _ := service.kernel.GraphOwner(graphId)
	owner := service.owner()
	ownerConversation := ""
	if owner.ConversationID != nil {
		ownerConversation = *owner.ConversationID
	}
	targetConversation := ""
	if target.ConversationID != nil {
		targetConversation = *target.ConversationID
	}
	if graphId != service.ownerTaskId && bindingOwner != service.ownerTaskId &&
		(ownerConversation == "" || targetConversation != ownerConversation) {
		Raise("permission", "Graph belongs to another conversation")
	}
	if service.kernel.LatestRevision(graphId) == nil {
		Raise("invalid_graph", "Target has no graph definition")
	}
	return NewGraphRuntime(service.kernel, graphId, service.artifacts)
}
