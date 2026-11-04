package graph

import (
	"encoding/json"
	"path/filepath"
	"sync"
)

type piAdapterSlot struct {
	acquire func(signal *AbortSignal) (func(), error)
}

// piAdapterPending is one in-flight system-change application.
type piAdapterPending struct {
	done  chan struct{}
	value any
	err   error
}

// piAdapterRunInput is the prepared state of one operation.
type piAdapterRunInput struct {
	Operation         Operation
	Entry             ModelEntry
	ModelNow          func(candidate ModelEntry) ModelEntry
	EndpointChanged   func(candidate ModelEntry, latest ModelEntry) bool
	ResolveKeyFor     func(candidate ModelEntry) string
	ResolveBinding    func(candidate ModelEntry) *PiAdapterBinding
	SlotFor           func(candidate ModelEntry) *piAdapterSlot
	Task              TaskRow
	ProjectRoot       string
	DefinitionVersion string
	AccessPolicy      *ResolvedAccessPolicy
	FullAccess        bool
	ActiveInstances   *map[string]AgentSession
	ActiveMu          *sync.Mutex
	TurnOrdinals      *map[string]func() int
	TurnOrdinalsMu    *sync.Mutex
	SystemChanges     *map[string]*piAdapterPending
	SystemChangesMu   *sync.Mutex
	// InterruptSignal fires when this operation is interrupted. A tool hands it
	// to the command runner so the process dies with the turn instead of running
	// to its own end.
	InterruptSignal *AbortSignal
}

// stringValue reads an optional string.
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// canonicalJSONString is the TypeScript JSON.stringify of a value, for comparison.
func canonicalJSONString(value any) string {
	if value == nil {
		return "{}"
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

// piAdapterRealpath is realpath() with the TypeScript fallback to the original path.
func piAdapterRealpath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return resolved
}

// piAdapterOptionalRealpath is realpath() with the TypeScript `.catch(() => undefined)`
// fallback. A root that cannot be resolved is dropped from the grant list instead
// of being handed to the sandbox as a path that does not exist.
func piAdapterOptionalRealpath(path string) string {
	if path == "" {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ""
	}
	return resolved
}

// piAdapterTurnInput is the state one turn runs with.
type piAdapterTurnInput struct {
	Gate                    *TaskSendGate
	ObservedGate            SendGate
	Spec                    NodeSpec
	Conversation            *ConversationRow
	Workspace               string
	PermissionRequest       **CapabilityPermissionRequest
	AskedQuestion           **PiAdapterAskedQuestion
	ReloadReceipt           *map[string]any
	CapabilityOperation     CapabilityOperation
	ContextAssembly         *AgentContextAssembly
	Commands                *WorkspaceCommandRunner
	Tools                   []ToolDefinition
	ThinkingLevel           string
	ModelPolicyDigest       string
	ToolPolicyDigest        string
	ComposedPrompt          string
	AgentContext            *ResolvedAgentContext
	OnEvent                 func(event map[string]any)
	Parts                   map[string]*piAdapterPart
	PartsOrder              []string
	FlushDeltas             func(force bool)
	ToolSummaries           map[string]string
	ToolActivity            *[]PiAdapterToolActivity
	Activity                *[]PiAdapterActivityRecord
	NarrationByEntry        map[string]*PiAdapterActivityRecord
	ToolOrdinals            map[string]int
	ActiveConversationTools map[string]bool
	PersistEntries          bool
	SawAssistantMessageEnd  *bool
	Compacting              *bool
	GateRefusal             *error
	Retrieval               *RetrievalBroker
	ArtifactService         *PiAdapterArtifactService
	Role                    string
	NextOrdinal             func() int
}
