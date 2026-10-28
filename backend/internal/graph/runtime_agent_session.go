package graph

// AgentSessionBinding is the resident worker's persisted identity.
type AgentSessionBinding struct {
	InstanceId        string `json:"instanceId"`
	NodeId            string `json:"nodeId"`
	DefinitionVersion string `json:"definitionVersion"`
}

// AgentSessionContext is how one session came to be.
//
// The TypeScript source declares the same members twice (AgentSessionContext
// here and SessionContextInfo in pi-instance.ts). Go has one package, so the
// two names carry one shape.
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

// AgentSessionExtensionError is one Pi extension that failed to load.
type AgentSessionExtensionError struct {
	Path  string `json:"path"`
	Error any    `json:"error"`
}

// AgentSessionInspect is the session's own view of itself.
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

// AgentSessionUsage is the token usage one assistant message reported.
type AgentSessionUsage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Total      int `json:"total"`
}

// AgentSessionTurn is the result of one prompt.
type AgentSessionTurn struct {
	Inspect            AgentSessionInspect `json:"inspect"`
	FinalAssistantText string              `json:"finalAssistantText"`
	StopReason         *string             `json:"stopReason,omitempty"`
	ErrorMessage       *string             `json:"errorMessage,omitempty"`
	Usage              *AgentSessionUsage  `json:"usage,omitempty"`
}

// AgentSessionRequest is one Agent session to open.
type AgentSessionRequest struct {
	ExecutionId                string
	InputRequestId             string
	ExecutionConfiguration     any
	NodeExecutionConfiguration any
	CapabilityDescriptor       any
	CredentialReference        any
	// Binding is the persisted identity of the session.
	Binding AgentSessionBinding
	// Recovering opens the session to resume the very turn it recovers.
	// Such an open must not wait for that turn to become idle: it is the
	// turn that is being resumed.
	Recovering bool
	// OnToolCall is the reporting sink for executed tool calls.
	OnToolCall func(call PiAdapterToolCall)
	// Workspace is the work copy the session runs in.
	Workspace string
	// StateDir is the instance directory of the session.
	StateDir string
	// Model is the provider model the session sends to.
	Model any
	// Stream is the provider stream the session sends through.
	Stream PromptStreamFunc
	// ThinkingLevel is the requested reasoning level.
	ThinkingLevel *string
	// Tools are the Graph tools the session may call.
	Tools []ToolDefinition
	// NativeTools are the Pi native tools the session may call.
	NativeTools []string
	// SkillPaths are the skills the session may read.
	SkillPaths []string
	// SkillFolder is the Agent's own skills folder.
	SkillFolder string
	// ReadRoots are the directories beside the workspace the session may read.
	ReadRoots []string
	// WriteRoots are the directories the session may write.
	WriteRoots []string
	// FilesystemAccess is bounded or host.
	FilesystemAccess string
	// ProtectedPaths are the paths the host protects.
	ProtectedPaths []string
	// AllowGitMetadataWritesAll lets the session write any git metadata.
	AllowGitMetadataWritesAll bool
	// Env is the environment the session may read.
	Env map[string]string
	// NetworkDomains are the granted network domains.
	NetworkDomains []string
	// AllowUnrestrictedNetwork opens the network reach.
	AllowUnrestrictedNetwork bool
	// AllowLocalBinding lets the session bind a local port.
	AllowLocalBinding bool
	// UnixSockets are the granted unix sockets.
	UnixSockets []string
	// AllowAllUnixSockets opens every unix socket.
	AllowAllUnixSockets bool
	// AllowAppleEvents lets the session send Apple events.
	AllowAppleEvents bool
	// PiExtensionPaths are the Pi extensions the session loads.
	PiExtensionPaths []string
	// PiExtensionTools are the tools the Pi extensions register.
	PiExtensionTools []string
	// ExtensionProcessAllowed says the session's policy is as wide as the
	// daemon's own reach, so a Pi extension may run in a process of its own.
	//
	// The extension's process has the daemon's reach: it reads and writes the
	// host and reaches the network. A session that may not do that itself may
	// not host an extension either.
	ExtensionProcessAllowed bool
	// McpAdapterServers are the MCP servers the adapter registers.
	McpAdapterServers []McpAdapterServerRef
	// SystemPrompt is the Graph system prompt.
	SystemPrompt string
	// AllowedToolNames are the tools the session may call.
	AllowedToolNames []string
	// BundleDigest is the capability bundle digest of the session.
	BundleDigest string
	// LegacyCapabilityDigest is the digest of the older capability format.
	LegacyCapabilityDigest *string
	// ToolPolicyDigest is the tool policy digest of the session.
	ToolPolicyDigest string
	// RuntimePolicyDigest is the runtime policy digest of the session.
	RuntimePolicyDigest string
	// AllowWorkspaceChange lets the host rebind an idle instance.
	AllowWorkspaceChange bool
	// FreshSession starts a new session instead of reopening the manifest.
	FreshSession bool
	// ForkFrom creates a new session file from an immutable source leaf.
	ForkFrom *PiWorkerForkFrom
	// ReadOnly turns off the tools that change business files.
	ReadOnly bool
	// Compaction are the compaction thresholds of the session.
	Compaction *CompactionSettings
	// Retry are the provider retry settings of the session.
	Retry *PiRetrySettings
	// Broker admits the model sends of the session.
	Broker SendGate
	// OnEvent receives the events of the session.
	OnEvent func(event map[string]any)
}

// AgentSession is one live Agent session.
type AgentSession interface {
	// Prompt sends one prompt and returns the turn it produced.
	Prompt(text string, images []ImageContent) (AgentSessionTurn, error)
	// Compact prepares the next operation's prompt.
	Compact(customInstructions string) error
	// Steer injects a message into the running turn.
	Steer(text string) error
	// Interrupt aborts the running turn. When text is present it becomes the
	// next prompt in the same session, keeping the interrupted operation alive.
	Interrupt(text *string) error
	// Stop soft-stops the running turn. The session and its transcript are kept.
	Stop() error
	// Inspect is the session's own view of itself.
	Inspect() AgentSessionInspect
	// Close ends the session.
	Close() error
}

// AgentSessionTransport opens Agent sessions.
type AgentSessionTransport interface {
	Open(request AgentSessionRequest) (AgentSession, error)
}
