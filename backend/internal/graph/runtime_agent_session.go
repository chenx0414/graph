package graph

type AgentSessionBinding struct {
	InstanceId        string `json:"instanceId"`
	NodeId            string `json:"nodeId"`
	DefinitionVersion string `json:"definitionVersion"`
}

type SessionContextInfo struct {
	Mode                    string  `json:"mode"`
	SourceSessionId         *string `json:"sourceSessionId,omitempty"`
	SourceSessionFile       *string `json:"sourceSessionFile,omitempty"`
	SourceLeafId            *string `json:"sourceLeafId,omitempty"`
	SourceContextDigest     *string `json:"sourceContextDigest,omitempty"`
	ReboundFromBundleDigest *string `json:"reboundFromBundleDigest,omitempty"`
	ChildContextDigest      string  `json:"childContextDigest"`
}

type AgentSessionContext = SessionContextInfo

type AgentSessionExtensionError struct {
	Path  string `json:"path"`
	Error any    `json:"error"`
}

type AgentSessionInspect struct {
	Binding              AgentSessionBinding          `json:"binding"`
	SessionId            string                       `json:"sessionId"`
	SessionFile          string                       `json:"sessionFile"`
	Model                *string                      `json:"model,omitempty"`
	Messages             []any                        `json:"messages"`
	LeafId               *string                      `json:"leafId"`
	BundleDigest         *string                      `json:"bundleDigest"`
	ToolPolicyDigest     *string                      `json:"toolPolicyDigest"`
	RuntimePolicyDigest  *string                      `json:"runtimePolicyDigest"`
	PiVersion            *string                      `json:"piVersion"`
	Context              *AgentSessionContext         `json:"context,omitempty"`
	ActiveTools          []string                     `json:"activeTools,omitempty"`
	RegisteredTools      []string                     `json:"registeredTools,omitempty"`
	LoadedExtensions     []string                     `json:"loadedExtensions,omitempty"`
	LoadedExtensionTools []string                     `json:"loadedExtensionTools,omitempty"`
	ExtensionErrors      []AgentSessionExtensionError `json:"extensionErrors,omitempty"`
}

type AgentSessionUsage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Total      int `json:"total"`
}

type AgentSessionTurn struct {
	Inspect            AgentSessionInspect `json:"inspect"`
	FinalAssistantText string              `json:"finalAssistantText"`
	StopReason         *string             `json:"stopReason,omitempty"`
	ErrorMessage       *string             `json:"errorMessage,omitempty"`
	Usage              *AgentSessionUsage  `json:"usage,omitempty"`
}

type AgentSessionRequest struct {
	ExecutionId                string
	InputRequestId             string
	ExecutionConfiguration     any
	NodeExecutionConfiguration any
	CapabilityDescriptor       any
	CredentialReference        any
	Binding AgentSessionBinding
	Recovering bool
	OnToolCall func(call PiAdapterToolCall)
	Workspace string
	StateDir string
	Model any
	Stream PromptStreamFunc
	ThinkingLevel *string
	Tools []ToolDefinition
	NativeTools []string
	SkillPaths []string
	SkillFolder string
	ReadRoots []string
	WriteRoots []string
	FilesystemAccess string
	ProtectedPaths []string
	AllowGitMetadataWritesAll bool
	Env map[string]string
	NetworkDomains []string
	AllowUnrestrictedNetwork bool
	AllowLocalBinding bool
	UnixSockets []string
	AllowAllUnixSockets bool
	AllowAppleEvents bool
	PiExtensionPaths []string
	PiExtensionTools []string
	ExtensionProcessAllowed bool
	McpServers []McpServerRef
	SystemPrompt string
	AllowedToolNames []string
	BundleDigest string
	LegacyCapabilityDigest *string
	ToolPolicyDigest string
	RuntimePolicyDigest string
	AllowWorkspaceChange bool
	FreshSession bool
	IsolatedContext bool
	ForkFrom *PiWorkerForkFrom
	ReadOnly bool
	Compaction *CompactionSettings
	Retry *PiRetrySettings
	Broker SendGate
	OnEvent func(event map[string]any)
}

type AgentSession interface {
	Prompt(text string, images []ImageContent) (AgentSessionTurn, error)
	Compact(customInstructions string) error
	Steer(text string) error
	Interrupt(text *string) error
	Stop() error
	Inspect() AgentSessionInspect
	Close() error
}

type AgentSessionTransport interface {
	Open(request AgentSessionRequest) (AgentSession, error)
}
