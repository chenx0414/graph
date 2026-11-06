package graph

type PiAdapterChannels struct {
	// Conversations is the conversation service, as far as tools over other conversations need it.
	// Supervisor is the Graph management surface of one task.
	Supervisor func(taskId string) PiAdapterSupervisor
	// Catalog is the capability catalog the session reads.
	Catalog *Catalog
	// Peers is same-graph Agent-to-Agent delivery: a peer's message reaches the target node like a
	// user prompt.
	Peers func(taskId string) PiAdapterPeers
	// AgentContext is the prompt library.
	AgentContext *AgentContextLibrary
	// BootstrapPrompts are the per-definition Graph prompts.
	BootstrapPrompts map[string]string
	// BootstrapToolPrompt is the Graph tool prompt.
	BootstrapToolPrompt *string
	// SystemContext is the system summary channel.
	SystemContext *PiAdapterSystemContext
	// Rsi is the self-improvement channel.
	Rsi *PiAdapterRsi
}

// PiAdapterSupervisor is the Graph management surface one Agent session may drive.
type PiAdapterSupervisor struct {
	ControlTask      func(input AgentToolsControlTask) any
	ResumeWork       func(input WorkResumeInstruction) any
	DelegateWork     func(input DelegateWorkInput) any
	ProposeWorkGraph func(input WorkDraftToolInput) any
	ReadWorkDraft    func(workID string, version int64) any
	Propose          func(proposal NativeProposal, requestId string, newVersion bool) any
	WithdrawDraft    func(input PiAdapterDraftAction) any
	ConfirmDraft     func(input PiAdapterConfirmDraft) any
	GraphState       func() any
	TaskStatus       func(input PiAdapterTaskStatus) any
	ValidateProposal func(proposal NativeProposal) any
	ListProjects     func() any
	BindProject      func(input PiAdapterBindProject) any
	ListProblems     func() any
	ResolveProblem   func(input PiAdapterResolveProblem) any
	// GraphManagement is the graph control surface the main Agent owns. The
	// TypeScript supervisor spread graphManagement() into itself, so the
	// graph tools read the same surface the supervisor exposes.
	GraphManagement AgentToolsGraphManagement
}

// PiAdapterDraftAction is one draft-scoped supervisor call.
type PiAdapterDraftAction struct {
	ProposalVersion int
	Reason          *string
	RequestId       string
}

// PiAdapterConfirmDraft approves one draft revision.
type PiAdapterConfirmDraft struct {
	ProposalVersion int
	DraftRevision   int
	TargetBranch    string
	Instruction     string
	RequestId       string
}

// PiAdapterTaskStatus asks the supervisor about a task or node.
type PiAdapterTaskStatus struct {
	TaskId      *string
	NodeId      *string
	WaitForNode *string
	TimeoutMs   *int
}

// PiAdapterBindProject binds a project to the running task.
type PiAdapterBindProject struct {
	ProjectId string
	RequestId string
}

// PiAdapterResolveProblem answers one parked problem.
type PiAdapterResolveProblem struct {
	QuestionId       string
	Action           string
	Response         *string
	Proof            *string
	RequestId        string
	ExpectedRevision *int64
}

// PiAdapterPeers is the peer delivery surface of one task.
type PiAdapterPeers struct {
	Deliver func(from string, input PiAdapterPeerDelivery) any
}

// PiAdapterPeerDelivery is one peer message.
type PiAdapterPeerDelivery struct {
	To        string
	Text      string
	RequestId string
}

// PiAdapterSystemContext is the system summary channel.
type PiAdapterSystemContext struct {
	SystemSummary func() map[string]any
}

// PiAdapterRsi is the self-improvement channel.
type PiAdapterRsi struct {
	Available bool
	// Status adds the checkout comparison (sync.deploy), which walks both checkouts through git.
	Status func(compare bool) any
	Apply  func(input any, context PiAdapterRsiContext) map[string]any
}

// PiAdapterRsiContext is the operation a self-improvement change belongs to.
type PiAdapterRsiContext struct {
	TaskId         string
	ConversationId *string
	OperationId    *string
}

// PiAdapterBinding is the full credential binding for one model, including concurrency caps.
type PiAdapterBinding struct {
	ApiKey        string
	CredentialId  string
	Limit         *int
	SharedGroupId *string
	GroupLimit    *int
}

// PiAdapterNetwork is the network reach one operation was granted.
type PiAdapterNetwork struct {
	RetrievalDomains []string
	McpDomains       []string
}
