package graph

import "strings"

// AgentPromptOrigin is who authored one prompt part.
type AgentPromptOrigin string

// AgentPromptPart is one block inside a system-prompt section.
type AgentPromptPart struct {
	ID      string
	Title   string
	Origin  AgentPromptOrigin
	Content string
	Source  string
}

// AgentPromptSectionID names a section Graph itself renders.
type AgentPromptSectionID string

const (
	AgentPromptSectionIdentity AgentPromptSectionID = "identity"
	AgentPromptSectionRules    AgentPromptSectionID = "rules"
	AgentPromptSectionDocs     AgentPromptSectionID = "docs"
)

// AgentPromptSection is identity, rules, or docs.
type AgentPromptSection struct {
	ID    AgentPromptSectionID
	Title string
	Parts []AgentPromptPart
}

// AgentToolPromptEntry is one tool declaration that travels outside the prompt text.
type AgentToolPromptEntry struct {
	Name             string
	Description      string
	Source           string
	Group            string
	Order            *int
	Version          *string
	Parameters       []string
	Permission       string
	Available        bool
	RuntimeAvailable *bool
}

// AgentCapabilityPromptEntry is one capability the agent may use.
type AgentCapabilityPromptEntry struct {
	ID             string   `json:"id"`
	Version        string   `json:"version"`
	Kind           string   `json:"kind"`
	Name           string   `json:"name"`
	Description    *string  `json:"description,omitempty"`
	Tools          []string `json:"tools"`
	Path           *string  `json:"path,omitempty"`
	NetworkDomains []string `json:"networkDomains,omitempty"`
	Reason         *string  `json:"reason,omitempty"`
}

// ComposeAgentSystemPromptInput is what Graph itself renders into the system prompt.
type ComposeAgentSystemPromptInput struct {
	Identity          string
	IdentityContext   string
	HarnessContext    string
	DefinitionVersion string
	ToolGuidance      string
	RulesCommon       string
	RulesRole         string
	RulesRuntime      string
	// ExperienceContext carries the lessons earlier runs of this project
	// learned. It is context, not a rule: it says what happened, never what
	// the host enforces.
	ExperienceContext    string
	Role                 string
}

// ComposedAgentSystemPrompt is the rendered sections and their joined text.
type ComposedAgentSystemPrompt struct {
	Sections []AgentPromptSection
	Text     string
}

func promptSection(id AgentPromptSectionID, title string, parts []AgentPromptPart) AgentPromptSection {
	kept := make([]AgentPromptPart, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(part.Content) != "" {
			kept = append(kept, part)
		}
	}
	return AgentPromptSection{ID: id, Title: title, Parts: kept}
}

func renderedSection(section AgentPromptSection) string {
	chunks := []string{}
	for _, part := range section.Parts {
		text := strings.TrimSpace(part.Content)
		if text != "" {
			chunks = append(chunks, text)
		}
	}
	return "<" + string(section.ID) + ">\n" + strings.Join(chunks, "\n\n") + "\n</" + string(section.ID) + ">"
}

// ComposeAgentSystemPrompt renders identity and rules.
func ComposeAgentSystemPrompt(input ComposeAgentSystemPromptInput) ComposedAgentSystemPrompt {
	rulesParts := []AgentPromptPart{
		{ID: "rules.common", Title: "Common rules", Origin: "editable", Content: input.RulesCommon, Source: "rules/common.md"},
		{ID: "rules.role", Title: "Role rules", Origin: "editable", Content: input.RulesRole, Source: "rules/<role>.md"},
	}
	if input.RulesRuntime != "" {
		rulesParts = append(rulesParts, AgentPromptPart{ID: "rules.runtime", Title: "Runtime rules", Origin: "editable", Content: input.RulesRuntime, Source: "runtime/*.md"})
	}
	rulesParts = append(rulesParts, AgentPromptPart{ID: "rules.tools", Title: "Tool guidance", Origin: "editable", Content: input.ToolGuidance, Source: "tools/<role>.md"})
	host := AGENT_TESTING_POLICY
	if input.Role != "main" {
		host += "\n\nThis directory is this operation's own Git worktree: relative paths resolve here, and it is neither necessarily the project root nor another Agent's worktree."
	}
	if input.ExperienceContext != "" {
		// The lessons sit before the host rules: they are what earlier runs
		// learned, and the host's own rules stay the last word.
		rulesParts = append(rulesParts, AgentPromptPart{
			ID: "rules.experience", Title: "Lessons earlier runs learned", Origin: "generated",
			Content: input.ExperienceContext, Source: "harness experience",
		})
	}
	rulesParts = append(rulesParts, AgentPromptPart{ID: "rules.host", Title: "Host rules", Origin: "generated", Content: host})
	rules := promptSection("rules", "Rules", rulesParts)
	identityParts := []AgentPromptPart{{
		ID: "identity.agent", Title: "Agent identity", Origin: "editable", Content: input.Identity, Source: "agents/<definition-id>.md",
	}}
	if strings.TrimSpace(input.IdentityContext) != "" {
		identityParts = append(identityParts, AgentPromptPart{ID: "identity.access", Title: "Access policy", Origin: "generated", Content: strings.TrimSpace(input.IdentityContext)})
	}
	if strings.TrimSpace(input.HarnessContext) != "" {
		identityParts = append(identityParts, AgentPromptPart{ID: "identity.harness", Title: "Harness self-improvement", Origin: "generated", Content: strings.TrimSpace(input.HarnessContext)})
	}
	identity := promptSection("identity", "Identity", identityParts)
	sections := []AgentPromptSection{identity, rules}
	rendered := make([]string, len(sections))
	for i, section := range sections {
		rendered[i] = renderedSection(section)
	}
	return ComposedAgentSystemPrompt{Sections: sections, Text: strings.Join(rendered, "\n\n")}
}
