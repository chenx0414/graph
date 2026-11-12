package graph

import "github.com/chenx0414/graph/backend/internal/agentcore"

type AgentSessionBinding = agentcore.Binding

type SessionContextInfo = agentcore.ContextInfo

type AgentSessionContext = agentcore.ContextInfo

type AgentSessionExtensionError = agentcore.ExtensionError

type AgentSessionInspect = agentcore.Inspect

type AgentSessionUsage = agentcore.Usage

type AgentSessionTurn = agentcore.Turn

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
	SkipContextPreparation bool
	Retry *PiRetrySettings
	Broker SendGate
	OnEvent func(event map[string]any)
}

type AgentSession = agentcore.Session

type AgentSessionTransport interface {
	Open(request AgentSessionRequest) (AgentSession, error)
}
