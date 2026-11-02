package graph

import (
	"os"
)

// sessionToolDeclarations are the tools that reach another conversation, the
// capability library, the system inventory and the self-improvement surface.
func sessionToolDeclarations(set agentToolContext) []AgentToolDeclaration {
	main := set.main
	features := set.features
	scoped := os.Getenv("GRAPH_SCOPED_SYSTEM_CAPABILITIES") == "1"
	readSystem := "Read the configuration inventory: redacted subscription plans, model connections, Agent recipes and definitions, graph architectures, quota windows. Secrets are never included. Use it before choosing a model, assembling subagents or claiming that something is available."
	readSystemParams := tbObject(nil, nil)
	if scoped {
		readSystem += " section returns that one field; omit it for the full inventory."
		readSystemParams = tbObject([]tbField{{"section", tbOptional(tbUnionLiteral([]string{"configuredModels", "access", "agentCombinations", "agentDefinitions", "architectures", "subscriptionPlans", "summary", "capabilities", "agentContext", "application"}))}}, nil)
	}
	rsiArguments := PrepareToolArguments("apply_rsi_change")
	apply := AgentToolDeclaration{
		Name: "apply_rsi_change", Label: "Apply self-improvement change",
		Description: "Change Graph files, check and commit to rsi/*. Each change is a relative path plus write, replace, \"copy\", delete, or fromPath (a file already written); copy mirrors a revision. Failed checks keep edits; changes:[] retries. Activation runs the full gate, ends this operation and schedules reload. Wait while a reload is pending; ask before force interrupts work.",
		Parameters: tbObject([]tbField{
			{"title", tbString(nil)}, {"problem", tbString(nil)},
			{"evidence", tbOptional(tbString(nil))}, {"diagnosis", tbOptional(tbString(nil))},
			{"impact", tbOptional(tbString(nil))}, {"risk", tbOptional(tbString(nil))},
			{"changes", tbOptional(tbArray(tbObject([]tbField{
				{"path", tbString(map[string]any{"description": "Repository-relative file this change writes, replaces or deletes."})},
				{"action", tbString(nil)},
				{"content", tbOptional(tbString(nil))},
				{"from", tbOptional(tbString(map[string]any{"description": "Revision to copy the file from, for action \"copy\" (for example the commit of the branch you are mirroring)."}))},
				{"fromPath", tbOptional(tbString(map[string]any{"description": "Take the new text from this file already in the checkout (the keeper you wrote and ran) instead of inlining content."}))},
				{"edits", tbOptional(tbArray(tbObject([]tbField{{"oldText", tbString(nil)}, {"newText", tbString(nil)}}, []string{"oldText", "newText"})))},
			}, []string{"path", "action"})))},
			{"checks", tbOptional(tbArray(tbObject([]tbField{{"command", tbString(nil)}, {"args", tbArray(tbString(nil))}}, []string{"command", "args"})))},
			{"activate", tbOptional(tbBool())}, {"force", tbOptional(tbBool())},
		}, []string{"title", "problem"}),
		Available: main && features.Rsi != nil && features.Rsi.Apply, ExternallyGated: false,
	}
	if rsiArguments != nil {
		apply.PrepareArguments = rsiArguments
	}
	return []AgentToolDeclaration{
		{Name: "conversation_read", Label: "Read another conversation", Description: "Read another conversation: its transcript, the conversations that exist, or the events since a cursor. follow returns what happened after the cursor you pass, so call it again with the highest cursor you saw. Reading grants no authority over the other session: the user still owns it.", Parameters: tbObject([]tbField{{"action", tbUnionLiteral([]string{"list", "read", "follow"})}, {"conversationId", tbOptional(tbString(nil))}, {"after", tbOptional(tbNumber())}, {"limit", tbOptional(tbNumber())}, {"archived", tbOptional(tbBool())}}, []string{"action"}), Available: features.Conversations != nil && features.Conversations.Read},
		{Name: "conversation_write", Label: "Write into another conversation", Description: "Hand work to another conversation: send a message, steer a running turn with one (queued, then pushed into the running turn), or pause/resume it. Needs full access and may only address other conversations. The message arrives marked as coming from another Agent, never as the user, so report progress to the user.", Parameters: tbObject([]tbField{{"action", tbUnionLiteral([]string{"send", "steer", "pause", "resume"})}, {"conversationId", tbString(nil)}, {"text", tbOptional(tbString(nil))}, {"requestId", tbString(nil)}}, []string{"action", "conversationId", "requestId"}), Available: features.Conversations != nil && features.Conversations.Write},
		{Name: "search_resources", Label: "Search capability library", Description: "Search the capability directory (Skills, MCP servers, Pi extensions, Graph extensions, prompt identities). Results are discovery only: bind a capability into an Agent recipe or definition to make its tools available.", Parameters: tbObject([]tbField{{"query", tbOptional(tbString(nil))}, {"kind", tbOptional(tbString(nil))}, {"role", tbOptional(tbString(nil))}, {"limit", tbOptional(tbNumber())}, {"offset", tbOptional(tbNumber())}}, nil), Available: main && features.Catalog},
		{Name: "get_resource", Label: "Get capability details", Description: "Read one capability of search_resources by id or id@version. It never reads Agent recipes or definitions - use get_agent_combination for a recipe id (coder, not coder@5). Reading binds nothing.", Parameters: tbObject([]tbField{{"id", tbString(nil)}, {"version", tbOptional(tbString(nil))}}, []string{"id"}), Available: main && features.Catalog},
		{Name: "read_system_capabilities", Label: "Read system capabilities", Description: readSystem, Parameters: readSystemParams, Available: main && features.SystemContext != nil && features.SystemContext.SystemSummary},
		{Name: "inspect_graph_system", Label: "Inspect Graph health", Description: "Inspect runtime health for this conversation: invalid capabilities, open internal problems, failed nodes, unknown-usage records, artifact counts, pending system changes.", Parameters: tbObject(nil, nil), Available: main && features.SystemContext != nil && features.SystemContext.SystemDiagnostics},
		{Name: "propose_system_change", Label: "Propose system change", Description: "Propose a Graph system change for explicit user approval, with the exact machine-readable change. See docs/agent/self-configuration.md for the supported shapes.", Parameters: tbObject([]tbField{{"title", tbString(nil)}, {"problem", tbString(nil)}, {"changeJson", tbString(nil)}, {"impact", tbOptional(tbString(nil))}, {"risk", tbOptional(tbString(nil))}}, []string{"title", "problem", "changeJson"}), Available: main && features.SystemContext != nil && features.SystemContext.ProposeSystemChange},
		{Name: "apply_system_change", Label: "Apply approved system change", Description: "Apply one previously proposed system change, and only after the user approved it.", Parameters: tbObject([]tbField{{"proposalId", tbString(nil)}}, []string{"proposalId"}), Available: main && features.SystemContext != nil && features.SystemContext.ApplySystemChange},
		{Name: "inspect_rsi_status", Label: "Inspect self-improvement status", Description: "Inspect source root, branch, pending reload, active operations, unpublished branches and deployment differences before changing the harness.", Parameters: tbObject(nil, nil), Available: main && features.Rsi != nil && features.Rsi.Status},
		{Name: "list_peers", Label: "List peer Agents", Description: "List the other Agents of THIS graph with their status, so you can address one by id. A subagent may only talk to the nodes of its own graph. With send_to_peer this is how the Agents of one graph work together.", Parameters: tbObject(nil, nil), Available: features.Peers},
		{Name: "send_to_peer", Label: "Send a message to a peer Agent", Description: "Send a durable message to another Agent of this graph. It triggers a reply when the peer is idle and queues for a later serial turn while the peer is busy. It appears in the peer's chat window and the peer need not be running now. A retried requestId is the same message, not a second one.", Parameters: tbObject([]tbField{{"to", tbString(nil)}, {"text", tbString(nil)}, {"requestId", tbString(nil)}}, []string{"to", "text", "requestId"}), Available: features.Peers},
		{Name: "list_agent_combinations", Label: "List Agent combinations", Description: "List the subagent recipes composed from shared resource-library ids. Results are recipes, not installed definitions or permissions; inspect the referenced resources first.", Parameters: tbObject([]tbField{{"query", tbOptional(tbString(nil))}, {"grade", tbOptional(tbString(nil))}, {"limit", tbOptional(tbNumber())}}, nil), Available: main && features.Catalog},
		{Name: "get_agent_combination", Label: "Get Agent combination", Description: "Resolve a subagent recipe to its resources. Reading grants no capability; inspect resources before binding. Present its readable name together with its stable recipe id.", Parameters: tbObject([]tbField{{"id", tbString(nil)}}, []string{"id"}), Available: main && features.Catalog},
		apply,
	}
}
