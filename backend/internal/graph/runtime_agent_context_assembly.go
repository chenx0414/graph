package graph

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

type AgentContextAssemblyOptions struct {
	CapabilityBundleOptions
	Action string
	Runtime string
	Role string
	Workspace string
	Library *AgentContextLibrary
	FullAccess bool
	Retrieval bool
	Rsi bool
	ExperienceContext string
}

type AgentContextComposition struct {
	Tools        []AgentContextTool
	Capabilities []AgentCapabilityPromptEntry
	Composed     ComposedAgentSystemPrompt
}

type AgentContextPreview struct {
	Tools        []AgentContextTool
	Capabilities []AgentCapabilityPromptEntry
}

type AgentContextAssembly struct {
	Bundle *CapabilityBundleVersion
	DisabledTools []string
	Role string
	DefinitionVersion string

	common       string
	roleRules    string
	toolGuidance string
	runtimeRules *string
	bootstrap    *CapabilityBootstrap
	fullAccess   bool
	rsi          bool
	catalog      *Catalog
	experience string
}
