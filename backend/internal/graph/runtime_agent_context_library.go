package graph

import (
	"strings"
)

// AgentContextLibrary is the editable prompt library of one Graph installation.
type AgentContextLibrary struct {
	Root        string
	ContextRoot string
	defaults    resolvedAgentContextDefaults
	// overlay replaces the text of the named prompts. It is how one node runs
	// under a different harness than the rest: the replacement has to live in
	// the library the session reads, not beside it.
	overlay map[string]string
}

// WithOverlay returns a library that replaces the named prompts with the given
// texts. The base library is untouched.
func (library *AgentContextLibrary) WithOverlay(overlay map[string]string) *AgentContextLibrary {
	if library == nil || len(overlay) == 0 {
		return library
	}
	copied := *library
	copied.overlay = make(map[string]string, len(overlay))
	for key, text := range overlay {
		copied.overlay[key] = text
	}
	return &copied
}

// NewAgentContextLibrary opens a prompt library with optional built-in overrides.
func NewAgentContextLibrary(root string, defaults AgentContextDefaults) *AgentContextLibrary {
	library := &AgentContextLibrary{Root: root, ContextRoot: root}
	library.defaults = resolvedAgentContextDefaults{
		Identity:         agentContextDefault(defaults.Identity, AgentPromptDefaultIdentityText),
		CommonRules:      agentContextDefault(defaults.CommonRules, DEFAULT_COMMON_RULES),
		MainRules:        agentContextDefault(defaults.MainRules, DEFAULT_MAIN_RULES),
		WorkerRules:      agentContextDefault(defaults.WorkerRules, DEFAULT_WORKER_RULES),
		ReviewerRules:    agentContextDefault(defaults.ReviewerRules, DEFAULT_REVIEWER_RULES),
		MainTools:        agentContextDefault(defaults.MainTools, DEFAULT_MAIN_TOOL_GUIDANCE),
		WorkerTools:      agentContextDefault(defaults.WorkerTools, DEFAULT_WORKER_TOOL_GUIDANCE),
		ReviewerTools:    agentContextDefault(defaults.ReviewerTools, DEFAULT_REVIEWER_TOOL_GUIDANCE),
		Worker:           agentContextDefault(defaults.Worker, DEFAULT_WORKER_PROMPT),
		Node:             agentContextDefault(defaults.Node, DEFAULT_NODE_PROMPT),
		PromptSuggestion: agentContextDefault(defaults.PromptSuggestion, DEFAULT_PROMPT_SUGGESTION_PROMPT),
		Sediment:         agentContextDefault(defaults.Sediment, DEFAULT_SEDIMENT_PROMPT),
	}
	return library
}

// OpenAgentContextLibrary opens the prompt library of one state directory.
func OpenAgentContextLibrary(root string, defaults ...AgentContextDefaults) *AgentContextLibrary {
	selected := AgentContextDefaults{}
	if len(defaults) > 0 {
		selected = defaults[0]
	}
	return NewAgentContextLibrary(root, selected)
}

// agentContextDefault keeps a trimmed override, or the built-in text.
func agentContextDefault(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return fallback
	}
	return trimmed
}

// descriptor returns the fixed metadata of one prompt key.
func (library *AgentContextLibrary) descriptor(key AgentPromptKey) agentStaticPrompt {
	for _, prompt := range agentStaticPrompts {
		if string(prompt.Key) == key {
			return prompt
		}
	}
	Raise("invalid_input", "Unknown Agent prompt "+key)
	return agentStaticPrompt{}
}

// promptPath is the file one prompt key owns.
func (library *AgentContextLibrary) promptPath(key AgentPromptKey) string {
	library.descriptor(key)
	return agentContextPath(library.Root, key)
}

// userDefaultPath is the file that holds the user-owned reset default.
func (library *AgentContextLibrary) userDefaultPath(key AgentPromptKey) string {
	library.descriptor(key)
	return agentContextPath(library.Root, agentContextUserDefaultRoot+"/"+key)
}

// builtInContent is the shipped text of one prompt.
func (library *AgentContextLibrary) builtInContent(key AgentPromptKey) string {
	return library.fallbackContent(library.descriptor(key).Fallback)
}

// fallbackContent is the shipped text of one defaults slot.
func (library *AgentContextLibrary) fallbackContent(name string) string {
	switch name {
	case "identity":
		return library.defaults.Identity
	case "commonRules":
		return library.defaults.CommonRules
	case "mainRules":
		return library.defaults.MainRules
	case "workerRules":
		return library.defaults.WorkerRules
	case "reviewerRules":
		return library.defaults.ReviewerRules
	case "mainTools":
		return library.defaults.MainTools
	case "workerTools":
		return library.defaults.WorkerTools
	case "reviewerTools":
		return library.defaults.ReviewerTools
	case "worker":
		return library.defaults.Worker
	case "node":
		return library.defaults.Node
	case "promptSuggestion":
		return library.defaults.PromptSuggestion
	case "sediment":
		return library.defaults.Sediment
	}
	return ""
}

// descriptors lists every prompt of the library.
func (library *AgentContextLibrary) descriptors() []AgentPromptDescriptor {
	out := make([]AgentPromptDescriptor, 0, len(agentStaticPrompts))
	for _, prompt := range agentStaticPrompts {
		content := library.fallbackContent(prompt.Fallback)
		out = append(out, AgentPromptDescriptor{
			Key:               prompt.Key,
			Title:             prompt.Title,
			Description:       prompt.Description,
			Group:             prompt.Group,
			Fallback:          prompt.Fallback,
			File:              library.promptPath(string(prompt.Key)),
			Content:           content,
			DefaultContent:    content,
			Customized:        false,
			DefaultCustomized: false,
		})
	}
	return out
}

// userDefault reads the user-owned reset default of one prompt.
func (library *AgentContextLibrary) userDefault(key AgentPromptKey) (string, bool, error) {
	return agentContextReadOptional(library.userDefaultPath(key))
}

// effectiveDefault is the text a reset restores: the user default, else the built-in.
func (library *AgentContextLibrary) effectiveDefault(key AgentPromptKey) (string, error) {
	value, ok, err := library.userDefault(key)
	if err != nil {
		return "", err
	}
	if ok {
		return value, nil
	}
	return library.builtInContent(key), nil
}
