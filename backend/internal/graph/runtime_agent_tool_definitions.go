package graph

// graph:allow-large-file: the tool schema table, one declaration per tool

import (
	"errors"
	"os"
	"strings"
)

// TODO(port): TypeBox schema bytes from @earendil-works/pi-ai are not reproduced exactly. The objects below are the JSON shapes the declarations describe.

// AgentToolFeatures are the host bindings a declaration may see. A non-nil object is truthy.
type AgentToolFeatures struct {
	GraphManagement bool
	GraphRead       bool
	WorkspaceCommit bool
	Role            string
	ReadOnly        bool
	Run             bool
	Fetch           bool
	Catalog         bool
	Artifacts       *AgentArtifactAccess
	Supervisor      *AgentSupervisorFeatures
	SystemContext   *AgentSystemFeatures
	Rsi             *AgentRsiFeatures
	Harness         bool
	Conversations   *AgentConversationFeatures
	Peers           bool
}

// AgentArtifactAccess is the artifact namespaces one role may use.
type AgentArtifactAccess struct {
	AllowedNamespaces []string
	CanPromote        bool
}

// AgentSupervisorFeatures are the conversation controls offered to main.
type AgentSupervisorFeatures struct {
	ValidateProposal   bool
	GraphState         bool
	TaskStatus         bool
	ListProjects       bool
	BindProject        bool
	ListProblems       bool
	ResolveProblem     bool
	WithdrawDraft      bool
	ConfirmDraft       bool
	ArchiveDraft       bool
	RestoreDraft       bool
	DeleteDraft        bool
	ControlTask        bool
	PendingHumanChecks bool
	ReviewHumanCheck   bool
}

// AgentSystemFeatures are the read-only host inventory tools.
type AgentSystemFeatures struct {
	SystemSummary       bool
	SystemDiagnostics   bool
	ProposeSystemChange bool
	ApplySystemChange   bool
}

// AgentRsiFeatures are the self-improvement tools.
type AgentRsiFeatures struct {
	Status bool
	Apply  bool
}

// AgentConversationFeatures are channels to other conversations.
type AgentConversationFeatures struct {
	Read  bool
	Write bool
}

// AgentToolDeclaration is a tool surface before a handler is bound.
type AgentToolDeclaration struct {
	Name             string
	Label            string
	Description      string
	Parameters       any
	PrepareArguments func(args any) any
	Available        bool
	ExternallyGated  bool
}

// AGENT_TOOL_ARGUMENT_HINTS are host-free argument hints attached by tool name.
var AGENT_TOOL_ARGUMENT_HINTS = map[string]func(args any) string{
	"apply_rsi_change": RsiChangeShapeHint,
}

// PrepareToolArguments returns the hint seam, or nil when the tool has none.
func PrepareToolArguments(name string) func(args any) any {
	hint := AGENT_TOOL_ARGUMENT_HINTS[name]
	if hint == nil {
		return nil
	}
	return func(args any) any {
		problem := hint(args)
		if problem != "" {
			panic(errors.New(problem))
		}
		return args
	}
}

// AgentArtifactAccessFor is the namespace grant for one role and action.
func AgentArtifactAccessFor(input struct {
	Role   string
	Action string
}) AgentArtifactAccess {
	namespaces := []string{"plans", "research", "deliverables", "summaries"}
	if input.Role == "master" {
		namespaces = []string{"plans", "research", "reviews", "deliverables", "summaries"}
	} else if toolReviewAction(input.Action) {
		namespaces = []string{"reviews", "summaries"}
	}
	return AgentArtifactAccess{AllowedNamespaces: namespaces, CanPromote: input.Role == "master"}
}

func toolReviewAction(action string) bool {
	lower := strings.ToLower(action)
	return strings.Contains(lower, "review") || strings.Contains(lower, "verify") || strings.Contains(lower, "critic") || strings.Contains(lower, "jury")
}

// DescribeAgentTools returns the declarations that are available for these features.
func DescribeAgentTools(features AgentToolFeatures) []AgentToolDeclaration {
	declared := agentToolDeclarations(features)
	out := []AgentToolDeclaration{}
	for _, tool := range declared {
		if tool.Available {
			out = append(out, tool)
		}
	}
	return out
}

func agentToolDeclarations(features AgentToolFeatures) []AgentToolDeclaration {
	main := features.Role == "master"
	rsiArguments := PrepareToolArguments("apply_rsi_change")
	namespaces := []string{}
	if features.Artifacts != nil {
		namespaces = features.Artifacts.AllowedNamespaces
	}
	publishTail := ""
	if main {
		publishTail = " Set graphId to publish or revise an artifact in a graph you own; omit it to publish in your own task. A revision keeps the same namespace and name and preserves all earlier versions."
	}
	listLead := "List only shared artifacts owned by your current graph; subgraph nodes share the top-level graph workspace."
	if main {
		listLead = "List published task artifacts and shared project knowledge."
	}
	scoped := os.Getenv("GRAPH_SCOPED_SYSTEM_CAPABILITIES") == "1"
	readSystem := "Read configuration inventory: redacted subscription plans, model connections, current Agent recipes, compiled Agent definitions, graph architectures and quota windows. Secret values are never included. Use this before choosing a model, assembling subagents or claiming that something is available."
	readSystemParams := tbObject(nil, nil)
	if scoped {
		readSystem += " section returns that complete inventory field; omit it for the full inventory."
		readSystemParams = tbObject([]tbField{{"section", tbOptional(tbUnionLiteral([]string{"configuredModels", "access", "agentCombinations", "agentDefinitions", "architectures", "subscriptionPlans", "summary", "capabilities", "agentContext", "application"}))}}, nil)
	}
	apply := AgentToolDeclaration{
		Name: "apply_rsi_change", Label: "Apply self-improvement change",
		Description: "Change Graph itself: edit, add or delete files in the Graph source checkout, run checks, commit to a dedicated rsi/* branch and (when activate is true) schedule a reload. Use it for any harness improvement you can justify, not only bugs. Every change needs a repository-relative path, whatever its action: action \"write\" (full content), \"replace\" (each oldText must match exactly once in that file), \"copy\" (the file becomes exactly that revision's content - use it to mirror a file from another branch or checkout instead of retyping it, since a retyped file silently drops lines) or \"delete\" - one entry per file, shaped {path, action, content}, {path, action, edits: [{oldText, newText}]}, {path, action: \"copy\", from: \"<revision>\"} or {path, action: \"delete\"}. Supply checks for a fast inner loop; the full `node --run check` and `app:build` gate runs before a change goes live. If checks fail the change stays uncommitted so you can keep fixing; pass changes: [] to just re-run checks. activate=true ends this operation and leaves the change pending_reload, so do not start another improvement while a reload is pending. force reloads even while other operations run.",
		Parameters: tbObject([]tbField{
			{"title", tbString(nil)}, {"problem", tbString(nil)},
			{"evidence", tbOptional(tbString(nil))}, {"diagnosis", tbOptional(tbString(nil))},
			{"impact", tbOptional(tbString(nil))}, {"risk", tbOptional(tbString(nil))},
			{"changes", tbOptional(tbArray(tbObject([]tbField{
				{"path", tbString(map[string]any{"description": "Repository-relative file this change writes, replaces or deletes."})},
				{"action", tbString(nil)},
				{"content", tbOptional(tbString(nil))},
				{"from", tbOptional(tbString(map[string]any{"description": "Revision to copy the file from, for action \"copy\" (for example the commit of the branch you are mirroring)."}))},
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
	schemaNote := "Optional schema identity in kind@version form, e.g. source-list@1. The kind starts with a lowercase letter and contains lowercase letters, digits, dots, underscores or hyphens; version is a positive integer. Omit when no schema identity is needed."
	publishFields := []tbField{}
	publishRequired := []string{"namespace", "name", "requestId"}
	if main {
		publishFields = append(publishFields, tbField{"graphId", tbOptional(tbString(map[string]any{"minLength": 1}))})
	}
	publishFields = append(publishFields,
		tbField{"namespace", tbString(nil)}, tbField{"name", tbString(nil)},
		tbField{"sourcePath", tbOptional(tbString(nil))}, tbField{"content", tbOptional(tbString(nil))},
		tbField{"mediaType", tbOptional(tbString(nil))},
		tbField{"schema", tbOptional(tbString(map[string]any{"description": schemaNote}))},
		tbField{"title", tbOptional(tbString(nil))}, tbField{"summary", tbOptional(tbString(nil))},
		tbField{"tags", tbOptional(tbArray(tbString(nil)))},
		tbField{"expectedVersion", tbOptional(tbNumber())},
		tbField{"metadata", tbOptional(tbRecord())},
		tbField{"requestId", tbString(nil)},
	)
	return []AgentToolDeclaration{
		{Name: "read_graph", Label: "Read graph definition", Description: "Read this graph definition at the immutable revision used by your current execution. Select nodes, modules, edges, protocols, acceptance, inputs or outputs; id reads one named object, otherwise after/limit page through the section. Read-only: cannot change the graph or access another graph. The initial graph overview is a bounded preview; use this tool for full details.", Parameters: tbObject([]tbField{{"section", tbUnionLiteral([]string{"nodes", "modules", "edges", "protocols", "acceptance", "inputs", "outputs"})}, {"id", tbOptional(tbString(nil))}, {"after", tbOptional(tbInteger(map[string]any{"minimum": 0}))}, {"limit", tbOptional(tbInteger(map[string]any{"minimum": 1, "maximum": 50}))}}, []string{"section"}), Available: features.GraphRead},
		{Name: "graph_create", Label: "Create graph", Description: "Create an independently owned graph from a complete JSON definition. Nodes wait for input; read graph-v2.md under the Graph documentation directory for the schema.", Parameters: tbObject([]tbField{{"definition", tbAny()}, {"targetBranch", tbOptional(tbString(nil))}, {"requestId", tbOptional(tbString(nil))}}, []string{"definition"}), Available: main && features.GraphManagement},
		{Name: "graph_patch", Label: "Patch graph", Description: "Publish a full definition or local JSON merge patch with baseRevision concurrency control. Named objects merge; null removes a field. Current work keeps its config; connections apply at subsequent submit.", Parameters: tbObject([]tbField{{"graphId", tbString(nil)}, {"baseRevision", tbNumber()}, {"changes", tbAny()}}, []string{"graphId", "baseRevision", "changes"}), Available: main && features.GraphManagement},
		{Name: "graph_inspect", Label: "Inspect graph", Description: "Read graph summary, revision, nodes, paged queue/executions for recovery, results, edge delivery history (newest first, nextBefore is the next after cursor; large values have valueTruncated), edge_delivery (id=edge ID and deliveryId, explicitly reads one full value), paged module judgment state (chronological, nextAfter cursor), module_values (explicit full input/state read), module_transition (id=module ID and transitionId, one full judgment), final acceptance evidence, host operation records or provider_calls (actual model sends and unknown usage holds).", Parameters: tbObject([]tbField{{"graphId", tbString(nil)}, {"query", tbOptional(tbString(nil))}, {"id", tbOptional(tbString(nil))}, {"deliveryId", tbOptional(tbString(nil))}, {"transitionId", tbOptional(tbString(nil))}, {"after", tbOptional(tbNumber())}, {"limit", tbOptional(tbNumber())}}, []string{"graphId"}), Available: main && features.GraphManagement},
		{Name: "graph_control", Label: "Control graph", Description: "Pause/resume, retry/skip/cancel a queue item, reopen a module, cancel an interrupted host operation, request/withdraw completion, stop, or explicitly relayout the canvas. Read graph-v2.md under the Graph documentation directory for action constraints.", Parameters: tbObject([]tbField{{"graphId", tbString(nil)}, {"action", tbString(nil)}, {"nodeId", tbOptional(tbString(nil))}, {"moduleId", tbOptional(tbString(nil))}, {"seq", tbOptional(tbNumber())}, {"operationId", tbOptional(tbString(nil))}, {"callId", tbOptional(tbString(nil))}, {"usage", tbOptional(tbObject([]tbField{{"input", tbNumber()}, {"output", tbNumber()}, {"cacheRead", tbNumber()}, {"cacheWrite", tbNumber()}}, []string{"input", "output", "cacheRead", "cacheWrite"}))}}, []string{"graphId", "action"}), Available: main && features.GraphManagement},
		{Name: "graph_send", Label: "Send to graph agent", Description: "Send text as queued chat, or value through a named input using the same protocol and serial execution rules.", Parameters: tbObject([]tbField{{"graphId", tbString(nil)}, {"nodeId", tbOptional(tbString(nil))}, {"input", tbOptional(tbString(nil))}, {"value", tbOptional(tbAny())}, {"text", tbOptional(tbString(nil))}}, []string{"graphId"}), Available: main && features.GraphManagement},
		{Name: "read", Label: "Read file", Description: "Read a UTF-8 file or supported image from the instance workspace or a bound capability.", Parameters: tbObject([]tbField{{"path", tbString(nil)}}, []string{"path"}), Available: true},
		{Name: "write_file", Label: "Write file", Description: "Write a UTF-8 file inside the instance workspace.", Parameters: tbObject([]tbField{{"path", tbString(nil)}, {"content", tbString(nil)}}, []string{"path", "content"}), Available: !features.ReadOnly},
		{Name: "list_dir", Label: "List directory", Description: "List files in a workspace directory or a permitted read-only capability directory.", Parameters: tbObject([]tbField{{"path", tbString(nil)}}, []string{"path"}), Available: true},
		{Name: "workspace_commit", Label: "Commit workspace files", Description: "Create a stable Git commit of the named paths in this node worktree before publishing code or submitting its commit reference. Returns repository, commit and worktree. Does not publish artifacts, integrate work or deliver to the target branch.", Parameters: tbObject([]tbField{{"paths", tbArrayBound(tbString(nil), 1, 256)}, {"message", tbString(nil)}}, []string{"paths", "message"}), Available: features.WorkspaceCommit && !features.ReadOnly && !main && features.Role != "reviewer"},
		{Name: "artifact_list", Label: "List shared artifacts", Description: listLead + " This is the discovery surface for literature sets, plans, review reports and deliverables; it returns metadata only. Use artifact_read for bounded content.", Parameters: tbObject([]tbField{{"namespace", tbOptional(tbString(nil))}, {"prefix", tbOptional(tbString(nil))}, {"schema", tbOptional(tbString(map[string]any{"description": schemaNote}))}, {"tag", tbOptional(tbString(nil))}, {"trust", tbOptional(tbString(nil))}, {"includeRetired", tbOptional(tbBool())}, {"latestOnly", tbOptional(tbBool())}, {"limit", tbOptional(tbNumber())}, {"cursor", tbOptional(tbString(nil))}}, nil), Available: features.Artifacts != nil},
		{Name: "artifact_read", Label: "Read shared artifact", Description: "Read one immutable artifact by artifactId. Omit version to read the latest published version, which is useful for discovery but must not be treated as a frozen reference; text is returned within maxBytes, while binary content returns its immutable read-only path and metadata.", Parameters: tbObject([]tbField{{"artifactId", tbString(nil)}, {"version", tbOptional(tbNumber())}, {"maxBytes", tbOptional(tbNumber())}}, []string{"artifactId"}), Available: features.Artifacts != nil},
		{Name: "artifact_publish", Label: "Publish shared artifact", Description: "Publish an immutable artifact version. Give either sourcePath or content, never both: content is the simplest when the report is text you already hold. Allowed namespaces: " + strings.Join(namespaces, ", ") + ". sourcePath must name a regular file inside this operation's work copy - a report you wrote to /tmp is refused, so write the file into your work copy first and publish that path. Publishing never overwrites an earlier version; use expectedVersion for compare-and-swap. A deliverable your node declared is published for you when the node settles, so publishing those same bytes yourself adds no version." + publishTail, Parameters: tbObject(publishFields, publishRequired), Available: features.Artifacts != nil},
		{Name: "artifact_retire", Label: "Retire shared artifact version", Description: "Retire one superseded or withdrawn artifact version in an owned graph or main task, using its exact artifactId and version. Immutable bytes remain readable; ownership is checked by the host.", Parameters: tbObject([]tbField{{"artifactId", tbString(nil)}, {"version", tbNumber()}, {"reason", tbString(nil)}, {"requestId", tbString(nil)}}, []string{"artifactId", "version", "reason", "requestId"}), Available: features.Artifacts != nil && features.Artifacts.CanPromote},
		{Name: "artifact_promote", Label: "Promote artifact to project knowledge", Description: "Explicitly promote one exact task artifact version into project-scoped shared knowledge for future tasks in the same project. This does not mutate or retire the source version.", Parameters: tbObject([]tbField{{"artifactId", tbString(nil)}, {"version", tbNumber()}, {"requestId", tbString(nil)}}, []string{"artifactId", "version", "requestId"}), Available: features.Artifacts != nil && features.Artifacts.CanPromote},
		{Name: "run_command", Label: "Run command", Description: "Run an allowed command inside the work copy: command is a bare executable name (node or git) and args is a string array, for example {command:\"node\",args:[\"--test\",\"test/x.test.js\"]}. It is not a shell; git only supports read-only status/diff/log/show.", Parameters: tbObject([]tbField{{"command", tbString(nil)}, {"args", tbOptional(tbArray(tbString(nil)))}}, []string{"command"}), Available: features.Run && !features.ReadOnly, ExternallyGated: true},
		{Name: "git", Label: "Git (read-only)", Description: "Run one read-only git command in the current work copy. Output is capped at 20000 characters: a longer diff or log falls back to a --stat summary. Allowed subcommands: status, log, diff, show, blame, describe, rev-parse, ls-files, shortlog, grep, rev-list.", Parameters: tbObject([]tbField{{"subcommand", tbString(nil)}, {"args", tbOptional(tbArray(tbString(nil)))}, {"path", tbOptional(tbString(nil))}}, []string{"subcommand"}), Available: features.Run && !features.ReadOnly, ExternallyGated: true},
		{Name: "fetch", Label: "Fetch URL", Description: "Fetch a text document from a granted domain and return its body.", Parameters: tbObject([]tbField{{"url", tbString(nil)}}, []string{"url"}), Available: features.Fetch, ExternallyGated: true},
		{Name: "propose_graph", Label: "Propose graph", Description: "Submit a native graph draft for user confirmation: proposal {requirementVersion, summary, definition: {schemaVersion:2, name, protocols, nodes, modules, edges, inputs, outputs, acceptance}, acceptance:[{id,description,checkNode}], decisions?}. Read graph-v2.md in the Graph documentation directory for the complete JSON format. Nodes are named agent objects with recipe, task and interfaces; commands belong to operation modules. Keep main outside the definition. Outer acceptance must list every definition acceptance criterion with the same ID and description; check/review targets must match its module/node. Confirmation creates structure; graph_send explicitly starts work. Pass the structured proposal object. By default this edits the current unconfirmed draft in place and keeps its version number; set newVersion:true on your own judgement when a version is worth keeping as a milestone or for comparison - that is your decision as main, do not stop to ask the user for permission to version. If the task already has a confirmed graph, revise it in place with graph_patch instead of proposing a new draft.", Parameters: tbObject([]tbField{{"proposal", nativeProposalSchema()}, {"newVersion", tbOptional(tbBool())}, {"requestId", tbString(nil)}}, []string{"proposal", "requestId"}), Available: main && features.Supervisor != nil},
		{Name: "confirm_draft", Label: "Confirm draft", Description: "Confirm the current conversation draft on the user behalf, exactly like the confirmation card. A native graph is created awaiting explicit graph_send input; main receives its graph_ready notification. Call it only when the user explicitly asked you to confirm, and pass their words verbatim as instruction. targetBranch is required and must be the branch the user named. draftRevision is the concurrency credential of the draft you are confirming (read it from the briefing or conversations view): if the user edited the draft after you read it, the confirmation is refused so a newer draft is never confirmed by accident.", Parameters: tbObject([]tbField{{"proposalVersion", tbNumber()}, {"draftRevision", tbNumber()}, {"targetBranch", tbString(nil)}, {"instruction", tbString(nil)}, {"requestId", tbString(nil)}}, []string{"proposalVersion", "draftRevision", "targetBranch", "instruction", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.ConfirmDraft},
		{Name: "archive_draft", Label: "Archive draft", Description: "Archive one draft card of this conversation by version, so it leaves the active list while staying readable by version and restorable. Use it when the user wants a draft out of the way but kept. It never touches a graph that was already started from that version: the graph, its tasks, chats, evidence and frozen acceptance stay exactly as they are.", Parameters: tbObject([]tbField{{"proposalVersion", tbNumber()}, {"requestId", tbString(nil)}}, []string{"proposalVersion", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.ArchiveDraft},
		{Name: "restore_draft", Label: "Restore draft", Description: "Restore an archived draft card of this conversation by version, so it returns to the active list. When nothing newer is live and it still belongs to the current requirement it becomes the current draft again, so a following in-place edit keeps its version number instead of stacking a new one.", Parameters: tbObject([]tbField{{"proposalVersion", tbNumber()}, {"requestId", tbString(nil)}}, []string{"proposalVersion", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.RestoreDraft},
		{Name: "delete_draft", Label: "Delete draft", Description: "Delete one draft card of this conversation by version, at the user explicit request. It disappears from the active and archived lists and can no longer be read by version; an invisible tombstone keeps the audit trail and the version number is never handed out again. A graph already started from that version keeps its tasks, chats, evidence and frozen acceptance - this removes the card, never the work.", Parameters: tbObject([]tbField{{"proposalVersion", tbNumber()}, {"requestId", tbString(nil)}}, []string{"proposalVersion", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.DeleteDraft},
		{Name: "withdraw_draft", Label: "Withdraw draft", Description: "Withdraw the current unconfirmed draft of this conversation, so the briefing reports no draft and the next propose_graph keeps a fresh version. Retires the version instead of deleting it, and refuses a draft that is not the current one or is already confirmed. reason is optional and is shown to the user.", Parameters: tbObject([]tbField{{"proposalVersion", tbNumber()}, {"reason", tbOptional(tbString(nil))}, {"requestId", tbString(nil)}}, []string{"proposalVersion", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.WithdrawDraft},
		{Name: "validate_proposal", Label: "Validate graph proposal", Description: "Validate the same native proposal object accepted by propose_graph: {requirementVersion, summary, definition:{schemaVersion:2,...}, acceptance:[{id,description,checkNode}], decisions?}. Check the current requirement version and graph structural rules without creating a draft or dispatching work. Returns valid:true or valid:false with a concise error. Read graph-v2.md for the complete format.", Parameters: tbObject([]tbField{{"proposal", nativeProposalSchema()}}, []string{"proposal"}), Available: main && features.Supervisor != nil && features.Supervisor.ValidateProposal},
		{Name: "get_graph_state", Label: "Get graph state", Description: "Read the graph state of this conversation: proposal, revision, phase, node statuses, evidence, worktrees and internal problems.", Parameters: tbObject(nil, nil), Available: main && features.Supervisor != nil && features.Supervisor.GraphState},
		{Name: "get_task_status", Label: "Get task status", Description: "Read a compact status of one task: phase, graph version, per-node status with the model that actually runs it, open user questions, open internal problems and which acceptance evidence is currently valid. Much smaller than get_graph_state, so prefer it while polling. Pass nodeId to read a native node declared configuration for its next execution; graph_inspect queue/executions reports received work. Use waitForNode plus timeoutMs to wait until the node has no running or queued work, or reports a blocked/failed state.", Parameters: tbObject([]tbField{{"taskId", tbOptional(tbString(nil))}, {"nodeId", tbOptional(tbString(nil))}, {"waitForNode", tbOptional(tbString(nil))}, {"timeoutMs", tbOptional(tbNumber())}}, nil), Available: main && features.Supervisor != nil && features.Supervisor.TaskStatus},
		{Name: "list_projects", Label: "List projects", Description: "List the configured projects with their preparation state.", Parameters: tbObject(nil, nil), Available: main && features.Supervisor != nil && features.Supervisor.ListProjects},
		{Name: "bind_project", Label: "Bind project", Description: "Bind this conversation to a configured and prepared project. Binding another project invalidates the current draft.", Parameters: tbObject([]tbField{{"projectId", tbString(nil)}, {"requestId", tbString(nil)}}, []string{"projectId", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.BindProject},
		{Name: "list_problems", Label: "List execution problems", Description: "List internal execution problems currently owned by the main Agent. These are not user questions; inspect them before retrying, revising the graph, or asking the user for a real decision.", Parameters: tbObject(nil, nil), Available: main && features.Supervisor != nil && features.Supervisor.ListProblems && features.Supervisor.ResolveProblem},
		{Name: "resolve_problem", Label: "Resolve execution problem", Description: "Resolve one main-Agent-owned execution problem after diagnosis. Use retry for transient execution/context failures and for a result_noncompliant problem whose defects you can correct by re-asking the worker (the worker is told what is missing and does not redo the work); acknowledge only when the obstacle is externally cleared; respond when the worker asked a question; reconcile_usage only when the provider cannot supply authoritative usage and the rationale is recorded; escalate when the defect needs a decision only the user can make - that resolves your problem and opens a user question with your explanation attached, so the user answer becomes part of the next attempt.", Parameters: tbObject([]tbField{{"questionId", tbString(nil)}, {"action", tbString(nil)}, {"response", tbOptional(tbString(nil))}, {"proof", tbOptional(tbString(nil))}, {"requestId", tbString(nil)}}, []string{"questionId", "action", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.ListProblems && features.Supervisor.ResolveProblem},
		{Name: "list_human_checks", Label: "List human acceptance checks", Description: "List the human acceptance checks in this conversation that nobody has reviewed yet. A check that you already approved is not listed again. Use it when you were woken about a check, or before reporting that a task is waiting only on the user.", Parameters: tbObject(nil, nil), Available: main && features.Supervisor != nil && features.Supervisor.PendingHumanChecks && features.Supervisor.ReviewHumanCheck},
		{Name: "review_human_check", Label: "Review a human acceptance check", Description: "Record your look at one human acceptance check, before the user is asked. approve:true means the evidence looks right and the user should be asked (your review is attached); approve:false means it should not have been raised, so send the node back for rework instead. This is NOT acceptance: the check stays open and the user still has to pass it themselves. Approving twice writes nothing and returns false.", Parameters: tbObject([]tbField{{"questionId", tbString(nil)}, {"approve", tbBool()}, {"note", tbString(nil)}, {"requestId", tbString(nil)}}, []string{"questionId", "approve", "note", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.PendingHumanChecks && features.Supervisor.ReviewHumanCheck},
		{Name: "ask_user", Label: "Ask the user", Description: "Ask the user the one question whose answer changes the plan, then end this turn and wait for it. Write prompt and why in Markdown. When useful, offer concise options and set multiple true only when several choices can be selected together; the user can always write a custom answer. The answer arrives in your next turn as a recorded fact. Use it when the project, confirmed scope and recorded decisions cannot settle the choice.", Parameters: tbObject([]tbField{{"prompt", tbString(nil)}, {"why", tbString(nil)}, {"options", tbOptional(tbArray(tbString(nil)))}, {"multiple", tbOptional(tbBool())}, {"requestId", tbString(nil)}}, []string{"prompt", "why", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.ControlTask},
		{Name: "conversation_read", Label: "Read another conversation", Description: "Read another conversation: its transcript, the conversations that exist, or the events since a cursor. This is how a session follows work it handed to somebody else. follow returns what happened after the cursor you pass, so call it again with the highest cursor you saw to continue. Reading is not an authority over the other session: the user still owns it.", Parameters: tbObject([]tbField{{"action", tbUnionLiteral([]string{"list", "read", "follow"})}, {"conversationId", tbOptional(tbString(nil))}, {"after", tbOptional(tbNumber())}, {"limit", tbOptional(tbNumber())}, {"archived", tbOptional(tbBool())}}, []string{"action"}), Available: features.Conversations != nil && features.Conversations.Read},
		{Name: "conversation_write", Label: "Write into another conversation", Description: "Hand work to another conversation: send a message, steer a running turn with one (the text is queued, then pushed into the turn that is already running), or pause/resume it. Needs full access, and may only address other conversations; beyond that agents talk freely — a reply back is a message rather than a bounce, and one turn may hand out as many as it needs. The message arrives marked as coming from another Agent, never as the user, so report progress to the user instead of broadcasting.", Parameters: tbObject([]tbField{{"action", tbUnionLiteral([]string{"send", "steer", "pause", "resume"})}, {"conversationId", tbString(nil)}, {"text", tbOptional(tbString(nil))}, {"requestId", tbString(nil)}}, []string{"action", "conversationId", "requestId"}), Available: features.Conversations != nil && features.Conversations.Write},
		{Name: "control_task", Label: "Control a task", Description: "Control the task you are serving, or another task of the same conversation. pause soft-stops the running turn and waits for an explicit resume; resume continues it; abandon stops the whole task immediately (it is refused while a worker lane is still writing to the target, so pause first when work is in flight); set_budget sets one node budget as a positive token count or null for unlimited (null is what a master node normally runs with: a finite cap must still cover the context reservation of that node, so a small cap starves the instance it was meant to help); steer injects one message into the turn currently running on a node. Every action records its reason, and abandoning work the user still expects is never right.", Parameters: tbObject([]tbField{{"action", tbUnionLiteral([]string{"pause", "resume", "abandon", "set_budget", "steer"})}, {"taskId", tbOptional(tbString(nil))}, {"nodeId", tbOptional(tbString(nil))}, {"text", tbOptional(tbString(nil))}, {"tokens", tbOptional(tbUnion([]any{tbNumber(), map[string]any{"type": "null"}}))}, {"reason", tbOptional(tbString(nil))}, {"requestId", tbString(nil)}}, []string{"action", "requestId"}), Available: main && features.Supervisor != nil && features.Supervisor.ControlTask},
		{Name: "search_resources", Label: "Search capability library", Description: "Search the user capability directory (Skills, MCP servers, Pi extensions, Graph extensions and prompt identities). Search results are discovery only; bind a capability into a versioned Agent recipe or definition to make its tools available to that Agent.", Parameters: tbObject([]tbField{{"query", tbOptional(tbString(nil))}, {"kind", tbOptional(tbString(nil))}, {"role", tbOptional(tbString(nil))}, {"limit", tbOptional(tbNumber())}, {"offset", tbOptional(tbNumber())}}, nil), Available: main && features.Catalog},
		{Name: "get_resource", Label: "Get capability details", Description: "Read one capability returned by search_resources by id or id@version. This never reads Agent recipes or definitions; use get_agent_combination with the recipe id (for example coder, not coder@5). Reading details does not bind the capability.", Parameters: tbObject([]tbField{{"id", tbString(nil)}, {"version", tbOptional(tbString(nil))}}, []string{"id"}), Available: main && features.Catalog},
		{Name: "read_system_capabilities", Label: "Read system capabilities", Description: readSystem, Parameters: readSystemParams, Available: main && features.SystemContext != nil && features.SystemContext.SystemSummary},
		{Name: "inspect_graph_system", Label: "Inspect Graph health", Description: "Inspect runtime health for this conversation only: invalid capabilities, open internal problems, failed nodes, unknown-usage records, artifact counts and pending system changes. Configuration inventories are returned by read_system_capabilities, not duplicated here.", Parameters: tbObject(nil, nil), Available: main && features.SystemContext != nil && features.SystemContext.SystemDiagnostics},
		{Name: "propose_system_change", Label: "Propose system change", Description: "Propose a Graph system change for explicit user approval. Include the exact machine-readable change; see docs/agent/self-configuration.md for the supported shapes.", Parameters: tbObject([]tbField{{"title", tbString(nil)}, {"problem", tbString(nil)}, {"changeJson", tbString(nil)}, {"impact", tbOptional(tbString(nil))}, {"risk", tbOptional(tbString(nil))}}, []string{"title", "problem", "changeJson"}), Available: main && features.SystemContext != nil && features.SystemContext.ProposeSystemChange},
		{Name: "apply_system_change", Label: "Apply approved system change", Description: "Apply one previously proposed system change, and only after the user approved its question.", Parameters: tbObject([]tbField{{"proposalId", tbString(nil)}}, []string{"proposalId"}), Available: main && features.SystemContext != nil && features.SystemContext.ApplySystemChange},
		{Name: "inspect_rsi_status", Label: "Inspect self-improvement status", Description: "Read the Recursive Self-Improvement surface for Graph itself: the source checkout root, current branch, any pending restart, how many operations are still running, and the in-flight operation identities (id, task, node, request, archived). It also reports which local branches are ahead of the copy they were published to (`sync.unpublished`), which ones are self-improvement work lines that are never published by design (`sync.expected`), how many were never published (`sync.localOnly`), and how the checkout the app runs from compares to the development checkout of the same repository (`sync.deploy`: which files differ, which the development line has and this checkout lacks, and how many of those are under `src/`), compared against the remote-tracking refs known locally. Use it before changing the harness, to see whether a previous change is waiting to reload, and to notice unpublished work: a push channel that quietly stopped working shows up there and nowhere else.", Parameters: tbObject(nil, nil), Available: main && features.Rsi != nil && features.Rsi.Status},
		apply,
		{Name: "compare_harness_candidates", Label: "Compare harness candidates", Description: "Compare several candidates that ran the same task in one graph. It reads what each candidate actually did - whether it submitted, which outputs it sent, which tools it called, how many calls failed, what it cost and how long it took - and reports the difference against the baseline candidate. It also reports the harness each candidate ran under, so a difference can be traced back to the change that caused it. The candidates are anonymized on purpose: choose by what the answer contains, not by which lane produced it. The tool reports facts, never a verdict; picking the candidate is your decision, and there is no ground truth to appeal to. Pass domain to receive the lessons earlier tasks of that domain already adopted, so a new candidate is judged against what was learned rather than from scratch. Use it when several agents tried the same task and the next step is to keep the better harness, not merely the better answer.", Parameters: tbObject([]tbField{
			{"graphId", tbString(map[string]any{"description": "Graph the candidates belong to."})},
			{"nodeIds", tbArray(tbString(nil))},
			{"baselineNodeId", tbOptional(tbString(map[string]any{"description": "Candidate the others are compared against. Defaults to the first candidate by id."}))},
			{"domain", tbOptional(tbString(map[string]any{"description": "Domain the task belongs to; its adopted lessons come back with the comparison."}))},
		}, []string{"graphId", "nodeIds"}), Available: main && features.Harness},
		{Name: "record_harness_decision", Label: "Record harness decision", Description: "Record which candidate was adopted for a task and the lesson that comes with it, and promote it to the project so the next task of the same domain finds it. The lesson needs three parts: the cue (what the situation looked like), the lesson (what to do about it) and the evidence (what shows it worked). A decision without all three is refused: an unsupported lesson teaches the next task nothing. The cue is the identity of the record: recording a lesson under the cue of an open friction resolves that friction, so the situation and what to do about it stay one record instead of two. The stored set is read back in the result.", Parameters: tbObject([]tbField{
			{"graphId", tbOptional(tbString(map[string]any{"description": "Graph the compared candidates belong to, when the lesson came from a comparison."}))},
			{"domain", tbString(map[string]any{"description": "Domain the lesson belongs to; later tasks in this domain find it."})},
			{"axis", tbOptional(tbString(map[string]any{"description": "general (the lesson holds for every kind of work, and every domain finds it) or specific (it holds for this domain only). Claims the general axis only when the evidence shows it."}))},
			{"chosen", tbString(map[string]any{"description": "The candidate that was adopted, as compare_harness_candidates reported it. The anonymous id is fine: the host resolves it to the candidate that actually ran, so the lesson still names it later."})},
			{"cue", tbString(map[string]any{"description": "What the situation looked like when this lesson applies."})},
			{"lesson", tbString(map[string]any{"description": "What to do about it."})},
			{"evidence", tbString(map[string]any{"description": "What shows the lesson worked."})},
			{"harness", tbOptional(tbString(map[string]any{"description": "The harness change that produced the adopted behavior."}))},
			{"requestId", tbOptional(tbString(nil))},
		}, []string{"domain", "chosen", "cue", "lesson", "evidence"}), Available: main && features.Harness},
		{Name: "record_harness_friction", Label: "Record harness friction", Description: "Record friction the harness has: a situation that cost time, misled the work, or went wrong - before it is solved. It lands in the same store as the adopted lessons, so the two read as one body of knowledge: this is what we met, that is what we did about it. A friction is a suspicion, not a lesson: only adopted lessons travel into the prompts of later tasks, so recording one never puts a guess in front of the next task. Give the cue (the situation that happened) and why it matters. The cue is the identity of the record: recording the same cue again moves that record instead of adding another, so a friction that comes back is the same friction. When you later adopt what to do about it, record the lesson with the same cue and the friction becomes that lesson - one record at two stages. When a change addresses it, record the same cue again with status fixed and the reference that fixed it.", Parameters: tbObject([]tbField{
			{"domain", tbString(map[string]any{"description": "Domain the friction belongs to; later tasks in this domain find it."})},
			{"cue", tbString(map[string]any{"description": "The situation in which the friction showed up."})},
			{"why", tbString(map[string]any{"description": "Why it matters - what it cost or what it led to."})},
			{"axis", tbOptional(tbString(map[string]any{"description": "general (it is not about one kind of work) or specific (it is about this domain only)."}))},
			{"status", tbOptional(tbString(map[string]any{"description": "open, fixed or rejected. Record the same cue again to move it."}))},
			{"ref", tbOptional(tbString(map[string]any{"description": "What fixed it, for example the commit that did."}))},
			{"requestId", tbOptional(tbString(nil))},
		}, []string{"domain", "cue", "why"}), Available: main && features.Harness},
		{Name: "declare_harness_domain", Label: "Declare the harness domain", Description: "Tell the host what kind of work this project is, so the lessons of that domain reach the tasks that follow. The domain is one name - parser, billing, code review - and it is recorded for the project, not for one task: the kind of work a project does does not change with the conversation. Once it is declared, every later task of the project starts with the lessons of that domain and with the general ones. Declare it when the kind of work becomes clear, and declare it again if the project turns out to do more than one kind of work.", Parameters: tbObject([]tbField{
			{"domain", tbString(map[string]any{"description": "The name of the kind of work this project does."})},
			{"requestId", tbOptional(tbString(nil))},
		}, []string{"domain"}), Available: main && features.Harness},
		{Name: "read_harness_experience", Label: "Read harness experience", Description: "Read what the project knows about its own harness: one list of records, each a situation (the cue) and where it stands. A record that carries a lesson and the evidence for it is adopted; a record with only the situation is friction the project met and has not solved - it is not injected into any prompt. With a domain you get that domain's own records and the general ones - a lesson claimed on the general axis holds for every kind of work, so it reaches this domain too - together with the items of the retired harness-backlog artifact, which are the project's own friction history. Read it before working on a task whose kind of work was done before, so the harness starts from what was learned instead of from scratch. With no domain it lists the scopes that hold lessons.", Parameters: tbObject([]tbField{
			{"domain", tbOptional(tbString(map[string]any{"description": "Domain to read. Omit it to list the domains that hold lessons."}))},
		}, nil), Available: main && features.Harness},
		{Name: "read_harness_evidence", Label: "Read harness evidence", Description: "Read the evidence of this run: what each node did, which tool calls failed and why, what got blocked, how the last applied change checked out, and what it cost. This is what lets you improve the harness from evidence instead of from memory: read it before deciding what to change, and after a change that misbehaved. The default reading is a digest - per node the step count, the failed tool calls with their reasons, the final answer, plus the open problems, the failed nodes and the usage. Pass kind \"trajectory\" with a nodeId to walk one node's steps in order, and graphId to read a graph you own instead of this conversation. It reports facts, never a verdict: what to change is still your judgement.", Parameters: tbObject([]tbField{
			{"graphId", tbOptional(tbString(map[string]any{"description": "Graph to read. Omit it to read this conversation's own run."}))},
			{"nodeId", tbOptional(tbString(map[string]any{"description": "Read one node only."}))},
			{"kind", tbOptional(tbString(map[string]any{"description": "summary (the digest) or trajectory (the ordered steps of a node)."}))},
			{"limit", tbOptional(tbNumber())},
		}, nil), Available: main && features.Harness},
		{Name: "probe_harness", Label: "Probe harness variants", Description: "Run one task under several harnesses and get the contrast back. Give the task and two or more variants; each variant carries a label and the prompt texts it replaces (rules/common.md, rules/worker.md, tools/worker.md, runtime/node.md, agents/<definition-id>.md), so the only difference between the candidates is the harness. The host builds the probe graph, runs every candidate on the same task, waits for them to settle and reports what each one did differently - tools called, outputs sent, tokens spent, final answer. The candidates stay anonymous, so choose by what they produced rather than by which lane produced it; pass domain to get the lessons earlier tasks of that domain learned. Use it when you want to know which harness change actually helps, instead of guessing and shipping. The contrast it returns is the fact compare_harness_candidates reports and record_harness_decision keeps: after a probe, record the lesson you learned, so the next task starts with it.", Parameters: tbObject([]tbField{
			{"task", tbString(map[string]any{"description": "The task every candidate answers."})},
			{"variants", tbArray(tbObject([]tbField{
				{"label", tbString(map[string]any{"description": "Name of this candidate, so you can tell the variants apart."})},
				{"axis", tbOptional(tbString(map[string]any{"description": "general (a change that should hold for every kind of work) or specific (a change that holds for this domain only). Propose one of each when you can: the comparison then shows which kind of change actually pays off."}))},
				{"harness", tbOptional(tbObject(nil, nil))},
				{"recipe", tbOptional(tbString(map[string]any{"description": "Agent definition this candidate runs under; defaults to the probe's recipe."}))},
				{"model", tbOptional(tbString(map[string]any{"description": "Model this candidate runs on; defaults to the probe's model."}))},
			}, []string{"label"}))},
			{"recipe", tbOptional(tbString(map[string]any{"description": "Agent definition every candidate runs under unless its variant names one. read_system_capabilities lists them."}))},
			{"baseHarness", tbOptional(tbString(map[string]any{"description": "adopted to start every candidate from the harness this project already adopted, so the round tests a change on top of the last winner instead of beside it."}))},
			{"model", tbOptional(tbString(map[string]any{"description": "Model every candidate runs on unless its variant names one."}))},
			{"domain", tbOptional(tbString(map[string]any{"description": "Domain the task belongs to; its adopted lessons come back with the contrast."}))},
			{"timeoutMs", tbOptional(tbNumber())},
		}, []string{"task", "variants"}), Available: main && features.Harness},
		{Name: "list_peers", Label: "List peer Agents", Description: "List the other Agents of THIS graph with their status, so you can address one by id. A subagent may only talk to nodes of its own graph; naming another graph is refused. Together with send_to_peer this is how the Agents of one graph work together instead of each guessing what the others are doing.", Parameters: tbObject(nil, nil), Available: features.Peers},
		{Name: "send_to_peer", Label: "Send a message to a peer Agent", Description: "Send a durable message to another Agent of this graph. The message triggers a reply when the peer is idle; while it is busy, the message queues for a later serial turn in the same conversation. It appears in the peer chat window. The peer does not have to be running now. A retried requestId is the same message, not a second one. Only nodes of your own graph are reachable.", Parameters: tbObject([]tbField{{"to", tbString(nil)}, {"text", tbString(nil)}, {"requestId", tbString(nil)}}, []string{"to", "text", "requestId"}), Available: features.Peers},
		{Name: "list_agent_combinations", Label: "List Agent combinations", Description: "List subagent recipes composed from shared resource-library IDs. Results are recipes, not installed definitions or permissions; inspect the referenced resources before using one.", Parameters: tbObject([]tbField{{"query", tbOptional(tbString(nil))}, {"grade", tbOptional(tbString(nil))}, {"limit", tbOptional(tbNumber())}}, nil), Available: main && features.Catalog},
		{Name: "get_agent_combination", Label: "Get Agent combination", Description: "Resolve one subagent recipe to its source resources. This does not install, compose or authorize anything; use the returned resources and their metadata to prepare the required capabilities. When you present that Agent to the user, keep its readable name (for example Bob_coder) and pair it with the stable recipe id.", Parameters: tbObject([]tbField{{"id", tbString(nil)}}, []string{"id"}), Available: main && features.Catalog},
	}
}

type tbField struct {
	name   string
	schema any
}

func tbObject(fields []tbField, required []string) map[string]any {
	properties := map[string]any{}
	for _, field := range fields {
		properties[field.name] = field.schema
	}
	schema := map[string]any{"type": "object", "properties": properties}
	if required == nil {
		required = []string{}
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func tbString(extra map[string]any) map[string]any {
	schema := map[string]any{"type": "string"}
	for key, value := range extra {
		schema[key] = value
	}
	return schema
}

func tbNumber() map[string]any { return map[string]any{"type": "number"} }

func tbInteger(extra map[string]any) map[string]any {
	schema := map[string]any{"type": "integer"}
	for key, value := range extra {
		schema[key] = value
	}
	return schema
}

func tbBool() map[string]any { return map[string]any{"type": "boolean"} }

func tbAny() map[string]any { return map[string]any{} }

func tbOptional(schema any) any { return schema }

func tbArray(items any) map[string]any {
	return map[string]any{"type": "array", "items": items}
}

func tbArrayBound(items any, minItems, maxItems int) map[string]any {
	return map[string]any{"type": "array", "items": items, "minItems": minItems, "maxItems": maxItems}
}

func tbUnion(items []any) map[string]any {
	return map[string]any{"anyOf": items}
}

func tbUnionLiteral(values []string) map[string]any {
	items := make([]any, 0, len(values))
	for _, value := range values {
		items = append(items, map[string]any{"const": value})
	}
	return tbUnion(items)
}

func tbRecord() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": map[string]any{}}
}

func nativeProposalSchema() map[string]any {
	return tbObject([]tbField{
		{"requirementVersion", tbInteger(map[string]any{"minimum": 1})},
		{"summary", tbString(nil)},
		{"definition", tbAny()},
		{"acceptance", tbArray(tbObject([]tbField{{"id", tbString(nil)}, {"description", tbString(nil)}, {"checkNode", tbString(nil)}}, []string{"id", "description", "checkNode"}))},
		{"decisions", tbOptional(tbArray(tbString(nil)))},
	}, []string{"requirementVersion", "summary", "definition", "acceptance"})
}
