package graph

import (
	"strings"

	"fmt"
)

type BriefingAgentCombination struct {
	Id               string `json:"id"`
	Name             string `json:"name"`
	Description      string `json:"description"`
	Status           string `json:"status"`
}

type BriefingCatalog struct {
	Definitions       []string
	Capabilities      []string
	AgentCombinations []BriefingAgentCombination
}

type BriefingCapability struct {
	Id      string
	Version string
}

type BriefingSystemContext struct {
	Resources         bool
	AgentCombinations bool
	SystemSummary     bool
}

type BriefingExtra struct {
	Request       string
	Summary       *string
	Acceptance    []AcceptanceItem
	Capabilities  []BriefingCapability
	Catalog       *BriefingCatalog
	Conversation  *string
	Decisions     *string
	SystemContext *BriefingSystemContext
}

func Briefing(operation Operation, extra BriefingExtra) (string, int) {
	catalogDefinitions := []string{}
	catalogCapabilities := []string{}
	catalogAgentCombinations := []BriefingAgentCombination{}
	if extra.Catalog != nil {
		if extra.Catalog.Definitions != nil {
			catalogDefinitions = extra.Catalog.Definitions
		}
		if extra.Catalog.Capabilities != nil {
			catalogCapabilities = extra.Catalog.Capabilities
		}
		if extra.Catalog.AgentCombinations != nil {
			catalogAgentCombinations = extra.Catalog.AgentCombinations
		}
	}
	attachments := []string{}
	for _, message := range operation.Context.Messages {
		for _, attachment := range message.Attachments {
			if IsImageAttachment(attachment) {
				attachments = append(attachments, fmt.Sprintf("- %s (%d bytes, %s); delivered as an image attachment", attachment.Name, attachment.Size, attachment.Type))
				continue
			}
			mime := attachment.Type
			if mime == "" {
				mime = "text/plain"
			}
			attachments = append(attachments, strings.Join([]string{
				fmt.Sprintf("- %s (%d bytes, %s)", attachment.Name, attachment.Size, mime),
				"```text",
				attachment.Text,
				"```",
			}, "\n"))
		}
	}
	lines := []string{
		fmt.Sprintf("Request: %s", extra.Request),
		fmt.Sprintf("Requirement version: %d", operation.RequirementVersion),
	}
	if len(operation.Context.Messages) > 0 {
		rendered := make([]string, 0, len(operation.Context.Messages))
		for _, message := range operation.Context.Messages {
			id := ""
			if message.Id != nil && *message.Id != "" {
				id = fmt.Sprintf("[%s] ", *message.Id)
			}
			rendered = append(rendered, fmt.Sprintf("- %s(v%d) %s", id, message.RequirementVersion, message.Text))
		}
		lines = append(lines, "User messages:\n"+strings.Join(rendered, "\n"))
	} else {
		lines = append(lines, "")
	}
	if len(attachments) > 0 {
		lines = append(lines, "Attachments supplied by the user:\n"+strings.Join(attachments, "\n"))
	} else {
		lines = append(lines, "")
	}
	if extra.Conversation != nil && *extra.Conversation != "" {
		lines = append(lines, "Conversation and execution status:\n"+*extra.Conversation)
	} else {
		lines = append(lines, "")
	}
	if extra.Decisions != nil && *extra.Decisions != "" {
		lines = append(lines, "Decisions and constraints from the conversation:\n"+*extra.Decisions)
	} else {
		lines = append(lines, "")
	}
	if extra.Summary != nil && *extra.Summary != "" {
		lines = append(lines, "Summary: "+*extra.Summary)
	} else {
		lines = append(lines, "")
	}
	if len(extra.Acceptance) > 0 {
		items := make([]string, 0, len(extra.Acceptance))
		for _, item := range extra.Acceptance {
			items = append(items, fmt.Sprintf("- %s (check %s): %s", item.Id, item.CheckNode, item.Description))
		}
		lines = append(lines, "Acceptance:\n"+strings.Join(items, "\n"))
	} else {
		lines = append(lines, "")
	}
	setup := []string{}
	if len(extra.Capabilities) > 0 {
		items := make([]string, 0, len(extra.Capabilities))
		for _, item := range extra.Capabilities {
			items = append(items, fmt.Sprintf("- %s@%s", item.Id, item.Version))
		}
		setup = append(setup, "Bound capabilities:\n"+strings.Join(items, "\n"))
	}
	if len(catalogDefinitions) > 0 || len(catalogCapabilities) > 0 || len(catalogAgentCombinations) > 0 {
		items := []string{}
		for _, item := range catalogDefinitions {
			items = append(items, "- definition "+item)
		}
		for _, item := range catalogCapabilities {
			items = append(items, "- capability "+item)
		}
		for _, item := range catalogAgentCombinations {
			items = append(items, fmt.Sprintf("- Agent recipe %s (%s, %s): %s", item.Id, item.Name, item.Status, item.Description))
		}
		setup = append(setup, "Catalog:\n"+strings.Join(items, "\n"))
	}
	if extra.SystemContext != nil && (extra.SystemContext.Resources || extra.SystemContext.AgentCombinations || extra.SystemContext.SystemSummary) {
		system := []string{"System context (read-only; query before planning instead of guessing):"}
		if extra.SystemContext.Resources {
			system = append(system, "- search_resources / get_resource: the user capability directory of Skills, MCP servers, Pi extensions, Graph extensions and prompt identities. get_resource accepts id or id@version. Search is discovery only; definition-bound capabilities are available under the default capability-bypass runtime policy.")
		}
		if extra.SystemContext.AgentCombinations {
			system = append(system, "- list_agent_combinations / get_agent_combination: recipe descriptions summarize intended use and should guide subagent selection; use get_agent_combination with the recipe id (for example coder), not get_resource with a definition version (for example coder@5). Creating, editing or deleting a recipe goes through the console HTTP routes documented in docs/agent/agent-recipes.md.")
		}
		if extra.SystemContext.SystemSummary {
			system = append(system, "- read_system_capabilities: configured subscription plans, configured models, Agent definitions, graph architectures and quota windows (secrets excluded).")
		}
		setup = append(setup, strings.Join(system, "\n"))
	}
	if len(operation.Context.Answers) > 0 {
		setup = append(setup, "Answers: "+jsonStringify(operation.Context.Answers))
	}
	keptSetup := []string{}
	for _, line := range setup {
		if line != "" {
			keptSetup = append(keptSetup, line)
		}
	}
	kept := []string{}
	for _, line := range lines {
		if line != "" {
			kept = append(kept, line)
		}
	}
	kept = append(kept, keptSetup...)
	setupText := strings.Join(keptSetup, "\n")
	setupLength := 0
	if setupText != "" && strings.HasSuffix(strings.Join(kept, "\n"), setupText) {
		setupLength = len(setupText)
	}
	return strings.Join(kept, "\n"), setupLength
}
