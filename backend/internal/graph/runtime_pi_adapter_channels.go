package graph

type PiAdapterChannels struct {
	Supervisor func(taskId string) PiAdapterSupervisor
	Catalog *Catalog
	Peers func(taskId string) PiAdapterPeers
	AgentContext *AgentContextLibrary
	BootstrapPrompts map[string]string
	BootstrapToolPrompt *string
	SystemContext *PiAdapterSystemContext
	Rsi *PiAdapterRsi
}

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
	GraphManagement AgentToolsGraphManagement
}

type PiAdapterDraftAction struct {
	ProposalVersion int
	Reason          *string
	RequestId       string
}

type PiAdapterConfirmDraft struct {
	ProposalVersion int
	DraftRevision   int
	TargetBranch    string
	Instruction     string
	RequestId       string
}

type PiAdapterTaskStatus struct {
	TaskId      *string
	NodeId      *string
	WaitForNode *string
	TimeoutMs   *int
}

type PiAdapterBindProject struct {
	ProjectId string
	RequestId string
}

type PiAdapterResolveProblem struct {
	QuestionId       string
	Action           string
	Response         *string
	Proof            *string
	RequestId        string
	ExpectedRevision *int64
}

type PiAdapterPeers struct {
	Deliver func(from string, input PiAdapterPeerDelivery) any
}

type PiAdapterPeerDelivery struct {
	To        string
	Text      string
	RequestId string
}

type PiAdapterSystemContext struct {
	SystemSummary func() map[string]any
}

type PiAdapterRsi struct {
	Available bool
	CheckoutRoot func() *string
	Status func(compare bool) any
	Apply  func(input any, context PiAdapterRsiContext) map[string]any
}

type PiAdapterRsiContext struct {
	TaskId         string
	ConversationId *string
	OperationId    *string
}

type PiAdapterBinding struct {
	ApiKey        string
	CredentialId  string
	Limit         *int
	SharedGroupId *string
	GroupLimit    *int
}

type PiAdapterNetwork struct {
	RetrievalDomains []string
	McpDomains       []string
}
