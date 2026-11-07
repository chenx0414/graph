package graph

// AgentContextTool is one tool of the context projection: what the settings
// panel shows about the tool surface of an operation.
type AgentContextTool struct {
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	Source           string   `json:"source"`
	Group            string   `json:"group,omitempty"`
	Order            *int     `json:"order,omitempty"`
	Version          *string  `json:"version"`
	Parameters       []string `json:"parameters"`
	Permission       string   `json:"permission"`
	Available        bool     `json:"available"`
	RuntimeAvailable *bool    `json:"runtimeAvailable"`
	CapabilityId     *string  `json:"capabilityId"`
	Enabled          bool     `json:"enabled"`
}

// AgentContextAssemblyOptions selects the context of one operation.
type AgentContextAssemblyOptions struct {
	CapabilityBundleOptions
	// Action is what the operation does, for example work or review.
	Action string
	// Runtime is node for a graph node, worker for a plain operation.
	Runtime string
	// Role is master, worker or reviewer.
	Role string
	// Workspace is the work copy the operation runs in.
	Workspace string
	// Library is the editable prompt library.
	Library *AgentContextLibrary
	// FullAccess opens the host gates for the main Agent.
	FullAccess bool
	// Retrieval tells the prompt that the fetch tool is available.
	Retrieval bool
	// Rsi lets the main Agent change this Graph checkout.
	Rsi bool
	// ExperienceContext carries the lessons earlier runs of this project
	// learned, so the Agent starts with them instead of rediscovering them.
	ExperienceContext string
}

// AgentContextComposition is the prompt and the tool surface of one operation.
type AgentContextComposition struct {
	Tools        []AgentContextTool
	Capabilities []AgentCapabilityPromptEntry
	Composed     ComposedAgentSystemPrompt
}

// AgentContextPreview is the next-operation projection of the tool surface.
type AgentContextPreview struct {
	Tools        []AgentContextTool
	Capabilities []AgentCapabilityPromptEntry
}

// AgentContextAssembly is the resolved context of one operation.
type AgentContextAssembly struct {
	// Bundle is the capability closure the operation binds to.
	Bundle *CapabilityBundleVersion
	// DisabledTools are the tool names the user turned off.
	DisabledTools []string
	// Role is the effective role: main, worker or reviewer.
	Role string
	// DefinitionVersion is the recipe the context was built for.
	DefinitionVersion string

	common       string
	roleRules    string
	toolGuidance string
	runtimeRules *string
	bootstrap    *CapabilityBootstrap
	fullAccess   bool
	rsi          bool
	catalog      *Catalog
	// experience carries the lessons earlier runs of this project learned.
	experience string
}
