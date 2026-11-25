package graph

import "context"

type PiWorkerTool struct {
	Name             string   `json:"name"`
	Label            string   `json:"label"`
	Description      string   `json:"description"`
	PromptSnippet    *string  `json:"promptSnippet,omitempty"`
	PromptGuidelines []string `json:"promptGuidelines,omitempty"`
	Parameters       Json     `json:"parameters"`
}

type PiWorkerConfig struct {
	ExecutionId                string              `json:"executionId"`
	Binding                    AgentSessionBinding `json:"binding"`
	Workspace                  string              `json:"workspace"`
	StateDir                   string              `json:"stateDir"`
	Model                      any                 `json:"model"`
	ThinkingLevel              string              `json:"thinkingLevel"`
	Tools                      []PiWorkerTool      `json:"tools"`
	NativeTools                []string            `json:"nativeTools"`
	SkillPaths                 []string            `json:"skillPaths"`
	SkillFolder                *string             `json:"skillFolder,omitempty"`
	PiExtensionPaths           []string            `json:"piExtensionPaths"`
	PiExtensionTools           []string            `json:"piExtensionTools"`
	SystemPrompt               string              `json:"systemPrompt"`
	AllowedToolNames           []string            `json:"allowedToolNames"`
	BundleDigest               string              `json:"bundleDigest"`
	ToolPolicyDigest           string              `json:"toolPolicyDigest"`
	RuntimePolicyDigest        string              `json:"runtimePolicyDigest"`
	AllowWorkspaceChange       bool                `json:"allowWorkspaceChange,omitempty"`
	FilesystemAccess           *string             `json:"filesystemAccess,omitempty"`
	ProtectedPaths             []string            `json:"protectedPaths,omitempty"`
	AllowGitMetadataWritesAll  bool                `json:"allowGitMetadataWritesAll,omitempty"`
	FreshSession               bool                `json:"freshSession,omitempty"`
	ForkFrom                   *PiWorkerForkFrom   `json:"forkFrom,omitempty"`
	Compaction                 *CompactionSettings `json:"compaction,omitempty"`
	Retry                      *PiRetrySettings    `json:"retry,omitempty"`
	NodeExecutionConfiguration map[string]any      `json:"nodeExecutionConfiguration,omitempty"`
	CredentialReference        map[string]any      `json:"credentialReference,omitempty"`
	CapabilityDescriptor       any                 `json:"capabilityDescriptor,omitempty"`
}

type PiWorkerForkFrom struct {
	SessionFile string `json:"sessionFile"`
	LeafId      string `json:"leafId,omitempty"`
}

type PiRetrySettings struct {
	Enabled     bool                `json:"enabled"`
	MaxRetries  int                 `json:"maxRetries"`
	BaseDelayMs int                 `json:"baseDelayMs"`
	Provider    PiRetryProviderOnly `json:"provider"`
}

type PiRetryProviderOnly struct {
	MaxRetries int `json:"maxRetries"`
}

type PiToolAnswer struct {
	Ok   bool   `json:"ok"`
	Text string `json:"text"`
}

type PiTurnUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
	Total      int64 `json:"total"`
	Accounted  *bool `json:"accounted,omitempty"`
}

func piWorkerAdmitWithoutSettle(gate SendGate, callId string, admit func() any) any {
	return gate.Dispatch(callId, 0, admit)
}

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
