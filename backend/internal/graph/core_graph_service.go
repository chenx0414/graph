package graph

type GraphManagement interface {
	GraphCreate(input GraphCreateInput) any
	GraphPatch(input GraphPatchInput) any
	GraphInspect(input GraphInspectInput) any
	GraphControl(input GraphControlInput) any
	WaiveAcceptance(input GraphAcceptanceWaiveInput) any
	GraphSend(input GraphSendInput) any
	HarnessFriction(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessFrictionInput) HarnessFrictionResult
	HarnessCompare(input HarnessCompareInput) HarnessComparison
	HarnessExperience(input HarnessExperienceInput) HarnessExperienceResult
	HarnessDecision(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult
	HarnessProbe(input HarnessProbeInput) HarnessProbeResult
	HarnessEvidence(input HarnessEvidenceInput) HarnessEvidenceResult
}

type GraphCreateInput struct {
	Definition   any
	TargetBranch *string
	RequestId    *string
}

type GraphPatchInput struct {
	GraphId      string
	BaseRevision int
	Changes      PatchChange
}

type GraphInspectInput struct {
	GraphId      string
	Query        *string
	Id           *string
	DeliveryId   *string
	TransitionId *string
	After        *int
	Limit        *int
}

type GraphControlInput struct {
	GraphId         string
	Action          string
	NodeId          *string
	ModuleId        *string
	Seq             *int
	OperationId     *string
	CallId          *string
	Usage           *TokenUsage
	AgentTaskID     string
	SourceMessageID string
	Instruction     string
	RequestID       string
	Text            string
	Proof           string
	Limitations     []GraphAcceptanceLimitation
}

type GraphSendInput struct {
	GraphId string
	NodeId  *string
	Input   *string
	Value   any
	Text    *string
}

type GraphCreateResult struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   int             `json:"revision"`
	RequestId  string          `json:"requestId"`
	Replayed   bool            `json:"replayed"`
}

type GraphCreateBlocked struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   int             `json:"revision"`
	RequestId  string          `json:"requestId"`
	State      string          `json:"state"`
	Reason     string          `json:"reason"`
}

type graphManagementService struct {
	kernel      *KernelStore
	ownerTaskId string
	prepare     func(graphId string, branch string)
	artifacts   *ArtifactWorkspace
}

// scoped rebinds the service onto a transaction's store, so its bodies reach the database through
// the connection the transaction owns instead of waiting on the pool.
func (service *graphManagementService) scoped(tx *TaskStore) *graphManagementService {
	scoped := *service
	if service.kernel != nil {
		scoped.kernel = service.kernel.scoped(tx)
	}
	if service.artifacts != nil {
		scoped.artifacts = service.artifacts.scoped(tx)
	}
	return &scoped
}

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
	if bindingOwner != "" {
		currentOwner := service.kernel.Store.Task(bindingOwner)
		if currentOwner.ConversationID != nil {
			targetConversation = *currentOwner.ConversationID
		} else {
			targetConversation = ""
		}
	}
	if graphId != service.ownerTaskId && bindingOwner != service.ownerTaskId &&
		(ownerConversation == "" || targetConversation != ownerConversation) {
		Raise("permission", "Graph "+graphId+" belongs to conversation "+targetConversation+
			", not to this one ("+ownerConversation+"). Read it from that conversation, or ask its owner for the progress.")
	}
	if service.kernel.LatestRevision(graphId) == nil {
		Raise("invalid_graph", "Target has no graph definition")
	}
	return NewGraphRuntime(service.kernel, graphId, service.artifacts)
}
