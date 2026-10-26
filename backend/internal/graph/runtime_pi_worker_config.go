package graph

import "context"

// PiWorkerTool is one tool a node's turn may call.
type PiWorkerTool struct {
	Name             string   `json:"name"`
	Label            string   `json:"label"`
	Description      string   `json:"description"`
	PromptSnippet    *string  `json:"promptSnippet,omitempty"`
	PromptGuidelines []string `json:"promptGuidelines,omitempty"`
	Parameters       Json     `json:"parameters"`
}

// PiWorkerConfig is the config one node's turn is admitted with.
type PiWorkerConfig struct {
	ExecutionId               string                `json:"executionId"`
	Binding                   AgentSessionBinding   `json:"binding"`
	Workspace                 string                `json:"workspace"`
	StateDir                  string                `json:"stateDir"`
	Model                     any                   `json:"model"`
	ThinkingLevel             string                `json:"thinkingLevel"`
	Tools                     []PiWorkerTool        `json:"tools"`
	NativeTools               []string              `json:"nativeTools"`
	SkillPaths                []string              `json:"skillPaths"`
	SkillFolder               *string               `json:"skillFolder,omitempty"`
	PiExtensionPaths          []string              `json:"piExtensionPaths"`
	PiExtensionTools          []string              `json:"piExtensionTools"`
	McpAdapterServers         []McpAdapterServerRef `json:"mcpAdapterServers,omitempty"`
	SystemPrompt              string                `json:"systemPrompt"`
	AllowedToolNames          []string              `json:"allowedToolNames"`
	BundleDigest              string                `json:"bundleDigest"`
	ToolPolicyDigest          string                `json:"toolPolicyDigest"`
	RuntimePolicyDigest       string                `json:"runtimePolicyDigest"`
	AllowWorkspaceChange      bool                  `json:"allowWorkspaceChange,omitempty"`
	FilesystemAccess          *string               `json:"filesystemAccess,omitempty"`
	ProtectedPaths            []string              `json:"protectedPaths,omitempty"`
	AllowGitMetadataWritesAll bool                  `json:"allowGitMetadataWritesAll,omitempty"`
	FreshSession              bool                  `json:"freshSession,omitempty"`
	ForkFrom                  *PiWorkerForkFrom     `json:"forkFrom,omitempty"`
	Compaction                *CompactionSettings   `json:"compaction,omitempty"`
	Retry                     *PiRetrySettings      `json:"retry,omitempty"`
	// The admission the turn is restored with: the configuration it was
	// admitted with, the credential it may spend and the capability surface
	// it was given. A turn that never reached the model is sent again with
	// these, not with what the catalog holds now.
	NodeExecutionConfiguration map[string]any `json:"nodeExecutionConfiguration,omitempty"`
	CredentialReference        map[string]any `json:"credentialReference,omitempty"`
	CapabilityDescriptor       any            `json:"capabilityDescriptor,omitempty"`
}

// PiWorkerForkFrom is the immutable source leaf a new session is created from.
type PiWorkerForkFrom struct {
	SessionFile string `json:"sessionFile"`
	LeafId      string `json:"leafId,omitempty"`
}

// PiRetrySettings are the SDK retry settings one worker uses.
type PiRetrySettings struct {
	Enabled     bool                `json:"enabled"`
	MaxRetries  int                 `json:"maxRetries"`
	BaseDelayMs int                 `json:"baseDelayMs"`
	Provider    PiRetryProviderOnly `json:"provider"`
}

// PiRetryProviderOnly is the provider retry budget.
type PiRetryProviderOnly struct {
	MaxRetries int `json:"maxRetries"`
}

// PiToolAnswer is one tool call's answer, as the host reports it.
type PiToolAnswer struct {
	Ok   bool   `json:"ok"`
	Text string `json:"text"`
}

// PiTurnUsage is the usage one turn accounted for.
type PiTurnUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
	Total      int64 `json:"total"`
	Accounted  *bool `json:"accounted,omitempty"`
}

// piWorkerGatedTool is one tool behind the gate every call passes.
//
// A tool the host gates itself is called directly: the gate would admit it
// twice.
func piWorkerGatedTool(tool ToolDefinition, gate SendGate) func(id string, params map[string]any, signal context.Context) any {
	if tool.ExternallyGated {
		return func(id string, params map[string]any, signal context.Context) any {
			result, err := tool.Execute(id, params)
			if err != nil {
				return err
			}
			return result
		}
	}
	return func(id string, params map[string]any, signal context.Context) any {
		// The gate and the tool share one id.
		//
		// The id the gate holds is the invocation the budget ledger counts;
		// the id the tool holds is the tool call the write ledger captures.
		// Two ids make them two records that cannot be joined. One id makes
		// them the same call - which is what the TypeScript host does, and
		// what the node lane already does.
		callId := id
		result := gate.Dispatch(callId, 0, func() any {
			value, err := tool.Execute(id, params)
			if err != nil {
				return err
			}
			return value
		})
		defer gate.Settle(callId, &TokenUsage{})
		return result
	}
}
