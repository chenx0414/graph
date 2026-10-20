package graph

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type PiWorkerTool struct {
	Name             string   `json:"name"`
	Label            string   `json:"label"`
	Description      string   `json:"description"`
	PromptSnippet    *string  `json:"promptSnippet,omitempty"`
	PromptGuidelines []string `json:"promptGuidelines,omitempty"`
	Parameters       Json     `json:"parameters"`
}

// PiWorkerConfig is the worker config, as the file the Pi worker process reads. Kept apart from
// spawning so the mapping from a session request to worker options stays testable: a field
// dropped here disappears from the session without a trace.
type PiWorkerConfig struct {
	DurableDatabase           string                `json:"-"`
	DurableRequest            map[string]any        `json:"-"`
	ExecutionId               string                `json:"executionId"`
	Binding                   AgentSessionBinding   `json:"binding"`
	Workspace                 string                `json:"workspace"`
	StateDir                  string                `json:"stateDir"`
	Model                     any                   `json:"model"`
	ThinkingLevel             string                `json:"thinkingLevel"`
	DeferredCatalogTools      bool                  `json:"deferredCatalogTools"`
	DeferredBrowserTools      bool                  `json:"deferredBrowserTools"`
	CompactShellResults       bool                  `json:"compactShellResults"`
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
	LegacyCapabilityDigest    *string               `json:"legacyCapabilityDigest,omitempty"`
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

// PiWorkerInspect is the worker's own view of its session.
type PiWorkerInspect struct {
	AgentSessionInspect
	ProcessId int `json:"processId"`
}

// PiProcessOptions are the options one restricted Pi process is opened with.
type PiProcessOptions = AgentSessionRequest

// PiWorkerResolved is the resolved on-disk state one worker config is built from.
type PiWorkerResolved struct {
	Workspace        string
	StateDir         string
	SkillPaths       []string
	SkillFolder      *string
	PiExtensionPaths []string
	ForkFrom         *PiWorkerForkFrom
}

// BuildPiWorkerConfig is the worker config, as the file the Pi worker process reads.
func BuildPiWorkerConfig(options PiProcessOptions, resolved PiWorkerResolved) PiWorkerConfig {
	tools := options.Tools
	if tools == nil {
		tools = []ToolDefinition{}
	}
	thinkingLevel := "off"
	if options.ThinkingLevel != nil && *options.ThinkingLevel != "" {
		thinkingLevel = *options.ThinkingLevel
	}
	allowed := append([]string{}, options.AllowedToolNames...)
	if len(allowed) == 0 {
		allowed = []string{}
		for _, tool := range tools {
			allowed = append(allowed, tool.Name)
		}
		allowed = append(allowed, options.PiExtensionTools...)
	}
	if os.Getenv("GRAPH_DEFER_CATALOG_TOOLS") == "1" {
		allowed = append(allowed, "load_catalog_tools")
	}
	if os.Getenv("GRAPH_DEFER_BROWSER_TOOLS") == "1" {
		allowed = append(allowed, "load_browser_tools")
	}
	sort.Strings(allowed)
	systemPrompt := options.SystemPrompt
	if systemPrompt == "" {
		systemPrompt = "You are the " + options.Binding.NodeId + " Agent in Graph."
	}
	config := PiWorkerConfig{
		Binding:              options.Binding,
		Workspace:            resolved.Workspace,
		StateDir:             resolved.StateDir,
		Model:                options.Model,
		ThinkingLevel:        thinkingLevel,
		DeferredCatalogTools: os.Getenv("GRAPH_DEFER_CATALOG_TOOLS") == "1",
		DeferredBrowserTools: os.Getenv("GRAPH_DEFER_BROWSER_TOOLS") == "1",
		CompactShellResults:  os.Getenv("GRAPH_COMPACT_SHELL_RESULTS") == "1",
		Tools:                serializedPiWorkerTools(tools),
		NativeTools:          options.NativeTools,
		SkillPaths:           resolved.SkillPaths,
		PiExtensionPaths:     resolved.PiExtensionPaths,
		PiExtensionTools:     options.PiExtensionTools,
		SystemPrompt:         systemPrompt,
		AllowedToolNames:     allowed,
		BundleDigest:         options.BundleDigest,
		ToolPolicyDigest:     options.ToolPolicyDigest,
		RuntimePolicyDigest:  options.RuntimePolicyDigest,
		Compaction:           options.Compaction,
		Retry:                options.Retry,
	}
	if config.NativeTools == nil {
		config.NativeTools = []string{}
	}
	if config.SkillPaths == nil {
		config.SkillPaths = []string{}
	}
	if config.PiExtensionPaths == nil {
		config.PiExtensionPaths = []string{}
	}
	if config.PiExtensionTools == nil {
		config.PiExtensionTools = []string{}
	}
	if resolved.SkillFolder != nil {
		folder := *resolved.SkillFolder
		config.SkillFolder = &folder
	}
	if len(options.McpAdapterServers) > 0 {
		config.McpAdapterServers = append([]McpAdapterServerRef{}, options.McpAdapterServers...)
	}
	if options.LegacyCapabilityDigest != nil {
		digest := *options.LegacyCapabilityDigest
		config.LegacyCapabilityDigest = &digest
	}
	if options.AllowWorkspaceChange {
		config.AllowWorkspaceChange = true
	}
	if options.FilesystemAccess != "" {
		access := options.FilesystemAccess
		config.FilesystemAccess = &access
	}
	if len(options.ProtectedPaths) > 0 {
		config.ProtectedPaths = append([]string{}, options.ProtectedPaths...)
	}
	if options.AllowGitMetadataWritesAll {
		config.AllowGitMetadataWritesAll = true
	}
	if options.FreshSession {
		config.FreshSession = true
	}
	if resolved.ForkFrom != nil {
		fork := *resolved.ForkFrom
		config.ForkFrom = &fork
	}
	return config
}

// serializedPiWorkerTools is the tool surface the worker receives as plain data.
func serializedPiWorkerTools(tools []ToolDefinition) []PiWorkerTool {
	out := []PiWorkerTool{}
	for _, tool := range tools {
		out = append(out, PiWorkerTool{
			Name: tool.Name, Label: tool.Label, Description: tool.Description, Parameters: tool.Parameters,
		})
	}
	return out
}

// PiProcess is one Agent session in an independent, OS-restricted Pi process.

type piWorkerStderrBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *piWorkerStderrBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.Write(data)
}

func (buffer *piWorkerStderrBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String()
}

func piWorkerSplitEnv(entry string) (string, string, bool) {
	key, value, ok := strings.Cut(entry, "=")
	if !ok || key == "" {
		return "", "", false
	}
	return key, value, true
}

// piWorkerHelperEnv is the environment the worker helper runs with.
func piWorkerHelperEnv(env map[string]string, electron string, execPath string) []string {
	environment := map[string]string{}
	for _, entry := range os.Environ() {
		if key, value, ok := piWorkerSplitEnv(entry); ok {
			environment[key] = value
		}
	}
	for key, value := range env {
		environment[key] = value
	}
	if electron != "" {
		environment["ELECTRON_RUN_AS_NODE"] = "1"
	}
	if path, ok := env["PATH"]; ok {
		parts := []string{filepath.Dir(execPath)}
		for _, entry := range strings.Split(path, ":") {
			if entry != "" {
				parts = append(parts, entry)
			}
		}
		parts = append(parts, "/usr/bin", "/bin")
		environment["PATH"] = DeveloperPath(strings.Join(parts, ":"))
	}
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+environment[key])
	}
	return out
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
		callId := graphUUID()
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
