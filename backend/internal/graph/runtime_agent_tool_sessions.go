package graph

import (
	"os"
)

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
			{"dryRun", tbOptional(map[string]any{"type": "boolean", "description": "Apply the changes and run the checks, then restore the working tree: nothing is committed, nothing reloads."})},
		}, []string{"title", "problem"}),
		Available: main && features.Rsi != nil && features.Rsi.Apply, ExternallyGated: false,
	}
	if rsiArguments != nil {
		apply.PrepareArguments = rsiArguments
	}
	return []AgentToolDeclaration{
		{Name: "search_resources", Label: "Search capability library", Description: "Search the capability directory (Skills, MCP servers, Pi extensions, Graph extensions, prompt identities). Results are discovery only: bind a capability into an Agent recipe or definition to make its tools available.", Parameters: tbObject([]tbField{{"query", tbOptional(tbString(nil))}, {"kind", tbOptional(tbString(nil))}, {"role", tbOptional(tbString(nil))}, {"limit", tbOptional(tbNumber())}, {"offset", tbOptional(tbNumber())}}, nil), Available: main && features.Catalog},
		{Name: "read_system_capabilities", Label: "Read system capabilities", Description: readSystem, Parameters: readSystemParams, Available: main && features.SystemContext != nil && features.SystemContext.SystemSummary},
		{Name: "inspect_graph_system", Label: "Inspect Graph health", Description: "Inspect runtime health for this conversation: invalid capabilities, open internal problems, failed nodes, unknown-usage records, artifact counts, pending system changes.", Parameters: tbObject(nil, nil), Available: main && features.SystemContext != nil && features.SystemContext.SystemDiagnostics},
		{Name: "inspect_rsi_status", Label: "Inspect self-improvement status", Description: "Inspect source root, branch, pending reload, operations, unpublished branches and deployment differences before changing the harness; an interrupted apply is answered here.", Parameters: tbObject(nil, nil), Available: main && features.Rsi != nil && features.Rsi.Status},
		{Name: "list_peers", Label: "List peer Agents", Description: "List the other Agents of THIS graph with their status, so you can address one by id. A subagent may only talk to the nodes of its own graph. With send_to_peer this is how the Agents of one graph work together.", Parameters: tbObject(nil, nil), Available: features.Peers},
		{Name: "send_to_peer", Label: "Send a message to a peer Agent", Description: "Send a durable message to another Agent of this graph. It triggers a reply when the peer is idle and queues for a later serial turn while the peer is busy. It appears in the peer's chat window and the peer need not be running now. A retried requestId is the same message, not a second one.", Parameters: tbObject([]tbField{{"to", tbString(nil)}, {"text", tbString(nil)}, {"requestId", tbString(nil)}}, []string{"to", "text", "requestId"}), Available: features.Peers},
		apply,
	}
}
