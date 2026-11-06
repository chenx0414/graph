package graph

// GraphManagement is the main-agent management contract. Every target remains
// in the owner's conversation.
type GraphManagement interface {
	GraphCreate(input GraphCreateInput) any
	GraphPatch(input GraphPatchInput) any
	GraphInspect(input GraphInspectInput) any
	GraphControl(input GraphControlInput) any
	// WaiveAcceptance records the user's own waiver of one acceptance item.
	// It is a separate door from GraphControl on purpose: the actor that signs
	// for the user is the door, never a payload.
	WaiveAcceptance(input GraphAcceptanceWaiveInput) any
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
	// Limitations is what complete_with_limitations closes a blocked graph on.
	Limitations []GraphAcceptanceLimitation
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

// goalReferencesGraph reports whether a conversation holds the goal that runs this
// graph. That is the one case where a conversation may read a graph another
// conversation owns.
func goalReferencesGraph(store *TaskStore, conversationID, graphID string) bool {
	if conversationID == "" || graphID == "" {
		return false
	}
	row := kernelRow(store.Db, `SELECT 1 AS found FROM conversation_goals WHERE conversation_id=? AND graph_id=? LIMIT 1`, conversationID, graphID)
	return row != nil
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
		// A goal does not always run where it was written: a supervisor goal picks a
		// project, and the graph then belongs to that project's thread. The conversation
		// that holds the goal owns the responsibility for following it, so reading the
		// graph is exactly what it must be able to do. Anything else is still refused,
		// and the refusal names both conversations so the reader knows where to look.
		if !goalReferencesGraph(service.kernel.Store, ownerConversation, graphId) {
			Raise("permission", "Graph "+graphId+" belongs to conversation "+targetConversation+
				", not to this one ("+ownerConversation+"). Read it from that conversation, or ask its owner for the progress.")
		}
	}
	if service.kernel.LatestRevision(graphId) == nil {
		Raise("invalid_graph", "Target has no graph definition")
	}
	return NewGraphRuntime(service.kernel, graphId, service.artifacts)
}
