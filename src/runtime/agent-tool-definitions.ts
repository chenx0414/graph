import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { rsiChangeShapeHint } from './rsi.ts';

/** Facts about the host bindings, without executors or filesystem access. */
export interface AgentToolFeatures {
  graphManagement?: boolean;
  graphRead?: boolean;
  workspaceCommit?: boolean;
  role?: string;
  readOnly?: boolean;
  run?: boolean;
  fetch?: boolean;
  catalog?: boolean;
  artifacts?: { allowedNamespaces: readonly string[]; canPromote: boolean };
  supervisor?: Partial<Record<'validateProposal' | 'graphState' | 'taskStatus' | 'listProjects' | 'bindProject' | 'listProblems' | 'resolveProblem' | 'withdrawDraft' | 'confirmDraft' | 'archiveDraft' | 'restoreDraft' | 'deleteDraft' | 'controlTask' | 'pendingHumanChecks' | 'reviewHumanCheck', boolean>>;
  systemContext?: Partial<Record<'systemSummary' | 'systemDiagnostics' | 'proposeSystemChange' | 'applySystemChange', boolean>>;
  rsi?: Partial<Record<'status' | 'apply', boolean>>;
  /** Channels to other conversations, when this session has them. */
  conversations?: Partial<Record<'read' | 'write', boolean>>;
  /** Same-graph Agent-to-Agent messaging: where the peers are, and whether they can be addressed. */
  peers?: boolean;
}

export function agentArtifactAccess(input: { role?: string; action: string }) {
  return {
    allowedNamespaces: input.role === 'master'
      ? ['plans', 'research', 'reviews', 'deliverables', 'summaries']
      : /review|verify|critic|jury/i.test(input.action)
        ? ['reviews', 'summaries']
        : ['plans', 'research', 'deliverables', 'summaries'],
    canPromote: input.role === 'master',
  };
}

/** What a declaration carries before a handler is bound: the SDK surface minus execution (the handler is
 * bound by name in `agent-tools.ts`), plus the two facts this layer owns. `prepareArguments` is part of
 * the surface on purpose - it runs before the SDK's schema check. */
export type AgentToolDeclaration = Pick<ToolDefinition, 'name' | 'label' | 'description' | 'parameters' | 'prepareArguments'> & {
  available: boolean;
  externallyGated: boolean;
};

/** Argument hints by tool name. A real Agent process rebuilds every tool from the JSON its host sent, so a
 * closure cannot travel: the hint is attached by name on both sides instead (here and in `pi-worker.ts`).
 * Anything added to this table must stay free of host state - both processes run it. */
export const AGENT_TOOL_ARGUMENT_HINTS: Record<string, (args: unknown) => string | undefined> = {
  apply_rsi_change: rsiChangeShapeHint,
};

/** The `prepareArguments` seam for one tool, or undefined when it has no hint: it throws the hint before
 * the SDK's schema check, so the tool result reads as the mistake instead of as the schema it violated. */
export function prepareToolArguments(name: string): ((args: unknown) => unknown) | undefined {
  const hint = AGENT_TOOL_ARGUMENT_HINTS[name];
  if (!hint) return undefined;
  return (args: unknown) => {
    const problem = hint(args);
    if (problem) throw new Error(problem);
    return args;
  };
}

type Declaration = AgentToolDeclaration;

const nativeProposal = Type.Object({
  requirementVersion: Type.Integer({ minimum: 1 }), summary: Type.String(), definition: Type.Any(),
  acceptance: Type.Array(Type.Object({ id: Type.String(), description: Type.String(), checkNode: Type.String() })),
  decisions: Type.Optional(Type.Array(Type.String())),
});

function declarations(features: AgentToolFeatures) {
  const main = features.role === 'master';
  const rsiArguments = prepareToolArguments('apply_rsi_change');
  return {
    read_graph: { name: 'read_graph', label: 'Read graph definition', description: 'Read this graph definition at the immutable revision used by your current execution. Select nodes, modules, edges, protocols, acceptance, inputs or outputs; id reads one named object, otherwise after/limit page through the section. Read-only: cannot change the graph or access another graph. The initial graph overview is a bounded preview; use this tool for full details.', parameters: Type.Object({ section: Type.Union(['nodes', 'modules', 'edges', 'protocols', 'acceptance', 'inputs', 'outputs'].map(value => Type.Literal(value))), id: Type.Optional(Type.String()), after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), available: Boolean(features.graphRead), externallyGated: false },
    graph_create: { name: 'graph_create', label: 'Create graph', description: 'Create an independently owned graph from a complete JSON definition. Nodes wait for input; read graph-v2.md under the Graph documentation directory for the schema.', parameters: Type.Object({ definition: Type.Any(), targetBranch: Type.Optional(Type.String()), requestId: Type.Optional(Type.String()) }), available: main && Boolean(features.graphManagement), externallyGated: false },
    graph_patch: { name: 'graph_patch', label: 'Patch graph', description: 'Publish a full definition or local JSON merge patch with baseRevision concurrency control. Named objects merge; null removes a field. Current work keeps its config; connections apply at subsequent submit.', parameters: Type.Object({ graphId: Type.String(), baseRevision: Type.Number(), changes: Type.Any() }), available: main && Boolean(features.graphManagement), externallyGated: false },
    graph_inspect: { name: 'graph_inspect', label: 'Inspect graph', description: 'Read graph summary, revision, nodes, paged queue/executions for recovery, results, edge delivery history (newest first, nextBefore is the next after cursor; large values have valueTruncated), edge_delivery (id=edge ID and deliveryId, explicitly reads one full value), paged module judgment state (chronological, nextAfter cursor), module_values (explicit full input/state read), module_transition (id=module ID and transitionId, one full judgment), final acceptance evidence, host operation records or provider_calls (actual model sends and unknown usage holds).', parameters: Type.Object({ graphId: Type.String(), query: Type.Optional(Type.String()), id: Type.Optional(Type.String()), deliveryId: Type.Optional(Type.String()), transitionId: Type.Optional(Type.String()), after: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }), available: main && Boolean(features.graphManagement), externallyGated: false },
    graph_control: { name: 'graph_control', label: 'Control graph', description: 'Pause/resume, retry/skip/cancel a queue item, reopen a module, cancel an interrupted host operation, request/withdraw completion, stop, or explicitly relayout the canvas. Read graph-v2.md under the Graph documentation directory for action constraints.', parameters: Type.Object({ graphId: Type.String(), action: Type.String(), nodeId: Type.Optional(Type.String()), moduleId: Type.Optional(Type.String()), seq: Type.Optional(Type.Number()), operationId: Type.Optional(Type.String()), callId: Type.Optional(Type.String()), usage: Type.Optional(Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() })) }), available: main && Boolean(features.graphManagement), externallyGated: false },
    graph_send: { name: 'graph_send', label: 'Send to graph agent', description: 'Send text as queued chat, or value through a named input using the same protocol and serial execution rules.', parameters: Type.Object({ graphId: Type.String(), nodeId: Type.Optional(Type.String()), input: Type.Optional(Type.String()), value: Type.Optional(Type.Any()), text: Type.Optional(Type.String()) }), available: main && Boolean(features.graphManagement), externallyGated: false },
    read: {
      name: 'read', label: 'Read file', description: 'Read a UTF-8 file or supported image from the instance workspace or a bound capability.',
      parameters: Type.Object({ path: Type.String() }),
      available: true,
      externallyGated: false,
    },
    write_file: {
      name: 'write_file', label: 'Write file', description: 'Write a UTF-8 file inside the instance workspace.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      available: !features.readOnly,
      externallyGated: false,
    },
    list_dir: {
      name: 'list_dir', label: 'List directory', description: 'List files in a workspace directory or a permitted read-only capability directory.',
      parameters: Type.Object({ path: Type.String() }),
      available: true,
      externallyGated: false,
    },
    workspace_commit: {
      name: 'workspace_commit', label: 'Commit workspace files',
      description: 'Create a stable Git commit of the named paths in this node worktree before publishing code or submitting its commit reference. Returns repository, commit and worktree. Does not publish artifacts, integrate work or deliver to the target branch.',
      parameters: Type.Object({ paths: Type.Array(Type.String(), { minItems: 1, maxItems: 256 }), message: Type.String() }),
      available: Boolean(features.workspaceCommit) && !features.readOnly && !main && features.role !== 'reviewer',
      externallyGated: false,
    },
    artifact_list: {
      name: 'artifact_list',
      label: 'List shared artifacts',
      description: `${main ? 'List published task artifacts and shared project knowledge.' : 'List only shared artifacts owned by your current graph; subgraph nodes share the top-level graph workspace.'} This is the discovery surface for literature sets, plans, review reports and deliverables; it returns metadata only. Use artifact_read for bounded content.`,
      parameters: Type.Object({
        namespace: Type.Optional(Type.String()),
        prefix: Type.Optional(Type.String()),
        schema: Type.Optional(Type.String({ description: 'Optional schema identity in kind@version form, e.g. source-list@1. The kind starts with a lowercase letter and contains lowercase letters, digits, dots, underscores or hyphens; version is a positive integer. Omit when no schema identity is needed.' })),
        tag: Type.Optional(Type.String()),
        trust: Type.Optional(Type.String()),
        includeRetired: Type.Optional(Type.Boolean()),
        latestOnly: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Number()),
        cursor: Type.Optional(Type.String()),
      }),
      available: Boolean(features.artifacts),
      externallyGated: false,
    },
    artifact_read: {
      name: 'artifact_read',
      label: 'Read shared artifact',
      description: 'Read one immutable artifact by artifactId. Omit version to read the latest published version, which is useful for discovery but must not be treated as a frozen reference; text is returned within maxBytes, while binary content returns its immutable read-only path and metadata.',
      parameters: Type.Object({
        artifactId: Type.String(),
        version: Type.Optional(Type.Number()),
        maxBytes: Type.Optional(Type.Number()),
      }),
      available: Boolean(features.artifacts),
      externallyGated: false,
    },
    artifact_publish: {
      name: 'artifact_publish',
      label: 'Publish shared artifact',
      description: `Publish an immutable artifact version. Give either sourcePath or content, never both: content is the simplest when the report is text you already hold. Allowed namespaces: ${(features.artifacts?.allowedNamespaces ?? []).join(', ')}. sourcePath must name a regular file inside this operation's work copy - a report you wrote to /tmp is refused, so write the file into your work copy first and publish that path. Publishing never overwrites an earlier version; use expectedVersion for compare-and-swap. A deliverable your node declared is published for you when the node settles, so publishing those same bytes yourself adds no version.${main ? ' Set graphId to publish or revise an artifact in a graph you own; omit it to publish in your own task. A revision keeps the same namespace and name and preserves all earlier versions.' : ''}`,
      parameters: Type.Object({
        ...(main ? { graphId: Type.Optional(Type.String({ minLength: 1 })) } : {}),
        namespace: Type.String(),
        name: Type.String(),
        sourcePath: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        mediaType: Type.Optional(Type.String()),
        schema: Type.Optional(Type.String({ description: 'Optional schema identity in kind@version form, e.g. source-list@1. The kind starts with a lowercase letter and contains lowercase letters, digits, dots, underscores or hyphens; version is a positive integer. Omit when no schema identity is needed.' })),
        title: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        expectedVersion: Type.Optional(Type.Number()),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
        requestId: Type.String(),
      }),
      available: Boolean(features.artifacts),
      externallyGated: false,
    },
    artifact_retire: {
      name: 'artifact_retire',
      label: 'Retire shared artifact version',
      description: 'Retire one superseded or withdrawn artifact version in an owned graph or main task, using its exact artifactId and version. Immutable bytes remain readable; ownership is checked by the host.',
      parameters: Type.Object({ artifactId: Type.String(), version: Type.Number(), reason: Type.String(), requestId: Type.String() }),
      available: Boolean(features.artifacts?.canPromote),
      externallyGated: false,
    },
    artifact_promote: {
      name: 'artifact_promote',
      label: 'Promote artifact to project knowledge',
      description: 'Explicitly promote one exact task artifact version into project-scoped shared knowledge for future tasks in the same project. This does not mutate or retire the source version.',
      parameters: Type.Object({ artifactId: Type.String(), version: Type.Number(), requestId: Type.String() }),
      available: Boolean(features.artifacts?.canPromote),
      externallyGated: false,
    },
    run_command: {
      name: 'run_command', label: 'Run command', description: 'Run an allowed command inside the work copy: command is a bare executable name (node or git) and args is a string array, for example {command:"node",args:["--test","test/x.test.js"]}. It is not a shell; git only supports read-only status/diff/log/show.',
      parameters: Type.Object({ command: Type.String(), args: Type.Optional(Type.Array(Type.String())) }),
      available: Boolean(features.run && !features.readOnly),
      externallyGated: true,
    },
    git: {
      name: 'git', label: 'Git (read-only)', description: 'Run one read-only git command in the current work copy. Output is capped at 20000 characters: a longer diff or log falls back to a --stat summary. Allowed subcommands: status, log, diff, show, blame, describe, rev-parse, ls-files, shortlog, grep, rev-list.',
      parameters: Type.Object({
        subcommand: Type.String(),
        args: Type.Optional(Type.Array(Type.String())),
        path: Type.Optional(Type.String()),
      }),
      available: Boolean(features.run && !features.readOnly),
      externallyGated: true,
    },
    fetch: {
      name: 'fetch', label: 'Fetch URL', description: 'Fetch a text document from a granted domain and return its body.',
      parameters: Type.Object({ url: Type.String() }),
      available: Boolean(features.fetch),
      externallyGated: true,
    },
    propose_graph: {
      name: 'propose_graph', label: 'Propose graph', description: 'Submit a native graph draft for user confirmation: proposal {requirementVersion, summary, definition: {schemaVersion:2, name, protocols, nodes, modules, edges, inputs, outputs, acceptance}, acceptance:[{id,description,checkNode}], decisions?}. Read graph-v2.md in the Graph documentation directory for the complete JSON format. Nodes are named agent objects with recipe, task and interfaces; commands belong to operation modules. Keep main outside the definition. Outer acceptance must list every definition acceptance criterion with the same ID and description; check/review targets must match its module/node. Confirmation creates structure; graph_send explicitly starts work. Pass the structured proposal object. By default this edits the current unconfirmed draft in place and keeps its version number; set newVersion:true on your own judgement when a version is worth keeping as a milestone or for comparison - that is your decision as main, do not stop to ask the user for permission to version. If the task already has a confirmed graph, revise it in place with graph_patch instead of proposing a new draft.',
      parameters: Type.Object({ proposal: nativeProposal, newVersion: Type.Optional(Type.Boolean()), requestId: Type.String() }),
      available: main && Boolean(features.supervisor),
      externallyGated: false,
    },
    confirm_draft: {
      name: 'confirm_draft', label: 'Confirm draft', description: 'Confirm the current conversation draft on the user behalf, exactly like the confirmation card. A native graph is created awaiting explicit graph_send input; main receives its graph_ready notification. Call it only when the user explicitly asked you to confirm, and pass their words verbatim as instruction. targetBranch is required and must be the branch the user named. draftRevision is the concurrency credential of the draft you are confirming (read it from the briefing or conversations view): if the user edited the draft after you read it, the confirmation is refused so a newer draft is never confirmed by accident.',
      parameters: Type.Object({ proposalVersion: Type.Number(), draftRevision: Type.Number(), targetBranch: Type.String(), instruction: Type.String(), requestId: Type.String() }),
      available: main && Boolean(features.supervisor?.confirmDraft),
      externallyGated: false,
    },
    archive_draft: {
      name: 'archive_draft', label: 'Archive draft', description: 'Archive one draft card of this conversation by version, so it leaves the active list while staying readable by version and restorable. Use it when the user wants a draft out of the way but kept. It never touches a graph that was already started from that version: the graph, its tasks, chats, evidence and frozen acceptance stay exactly as they are.',
      parameters: Type.Object({ proposalVersion: Type.Number(), requestId: Type.String() }),
      available: main && Boolean(features.supervisor?.archiveDraft),
      externallyGated: false,
    },
    restore_draft: {
      name: 'restore_draft', label: 'Restore draft', description: 'Restore an archived draft card of this conversation by version, so it returns to the active list. When nothing newer is live and it still belongs to the current requirement it becomes the current draft again, so a following in-place edit keeps its version number instead of stacking a new one.',
      parameters: Type.Object({ proposalVersion: Type.Number(), requestId: Type.String() }),
      available: main && Boolean(features.supervisor?.restoreDraft),
      externallyGated: false,
    },
    delete_draft: {
      name: 'delete_draft', label: 'Delete draft', description: 'Delete one draft card of this conversation by version, at the user explicit request. It disappears from the active and archived lists and can no longer be read by version; an invisible tombstone keeps the audit trail and the version number is never handed out again. A graph already started from that version keeps its tasks, chats, evidence and frozen acceptance - this removes the card, never the work.',
      parameters: Type.Object({ proposalVersion: Type.Number(), requestId: Type.String() }),
      available: main && Boolean(features.supervisor?.deleteDraft),
      externallyGated: false,
    },
    withdraw_draft: {
      name: 'withdraw_draft', label: 'Withdraw draft', description: 'Withdraw the current unconfirmed draft of this conversation, so the briefing reports no draft and the next propose_graph keeps a fresh version. Retires the version instead of deleting it, and refuses a draft that is not the current one or is already confirmed. reason is optional and is shown to the user.',
      parameters: Type.Object({ proposalVersion: Type.Number(), reason: Type.Optional(Type.String()), requestId: Type.String() }),
      available: main && Boolean(features.supervisor?.withdrawDraft),
      externallyGated: false,
    },
    validate_proposal: {
      name: 'validate_proposal', label: 'Validate graph proposal', description: 'Validate the same native proposal object accepted by propose_graph: {requirementVersion, summary, definition:{schemaVersion:2,...}, acceptance:[{id,description,checkNode}], decisions?}. Check the current requirement version and graph structural rules without creating a draft or dispatching work. Returns valid:true or valid:false with a concise error. Read graph-v2.md for the complete format.',
      parameters: Type.Object({ proposal: nativeProposal }),
      available: main && Boolean(features.supervisor?.validateProposal),
      externallyGated: false,
    },
    get_graph_state: {
      name: 'get_graph_state', label: 'Get graph state', description: 'Read the graph state of this conversation: proposal, revision, phase, node statuses, evidence, worktrees and internal problems.',
      parameters: Type.Object({}),
      available: main && Boolean(features.supervisor?.graphState),
      externallyGated: false,
    },
    get_task_status: {
      name: 'get_task_status', label: 'Get task status', description: 'Read a compact status of one task: phase, graph version, per-node status with the model that actually runs it, open user questions, open internal problems and which acceptance evidence is currently valid. Much smaller than get_graph_state, so prefer it while polling. Pass nodeId to read a native node declared configuration for its next execution; graph_inspect queue/executions reports received work. Use waitForNode plus timeoutMs to wait until the node has no running or queued work, or reports a blocked/failed state.',
      parameters: Type.Object({
        taskId: Type.Optional(Type.String()),
        nodeId: Type.Optional(Type.String()),
        waitForNode: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      available: main && Boolean(features.supervisor?.taskStatus),
      externallyGated: false,
    },
    list_projects: {
      name: 'list_projects', label: 'List projects', description: 'List the configured projects with their preparation state.',
      parameters: Type.Object({}),
      available: main && Boolean(features.supervisor?.listProjects),
      externallyGated: false,
    },
    bind_project: {
      name: 'bind_project', label: 'Bind project', description: 'Bind this conversation to a configured and prepared project. Binding another project invalidates the current draft.',
      parameters: Type.Object({ projectId: Type.String(), requestId: Type.String() }),
      available: main && Boolean(features.supervisor?.bindProject),
      externallyGated: false,
    },
    list_problems: {
      name: 'list_problems', label: 'List execution problems', description: 'List internal execution problems currently owned by the main Agent. These are not user questions; inspect them before retrying, revising the graph, or asking the user for a real decision.',
      parameters: Type.Object({}),
      available: main && Boolean(features.supervisor?.listProblems && features.supervisor?.resolveProblem),
      externallyGated: false,
    },
    resolve_problem: {
      name: 'resolve_problem', label: 'Resolve execution problem', description: 'Resolve one main-Agent-owned execution problem after diagnosis. Use retry for transient execution/context failures and for a result_noncompliant problem whose defects you can correct by re-asking the worker (the worker is told what is missing and does not redo the work); acknowledge only when the obstacle is externally cleared; respond when the worker asked a question; reconcile_usage only when the provider cannot supply authoritative usage and the rationale is recorded; escalate when the defect needs a decision only the user can make - that resolves your problem and opens a user question with your explanation attached, so the user answer becomes part of the next attempt.',
      parameters: Type.Object({
        questionId: Type.String(),
        action: Type.String(),
        response: Type.Optional(Type.String()),
        proof: Type.Optional(Type.String()),
        requestId: Type.String(),
      }),
      available: main && Boolean(features.supervisor?.listProblems && features.supervisor?.resolveProblem),
      externallyGated: false,
    },
    list_human_checks: {
      name: 'list_human_checks', label: 'List human acceptance checks', description: 'List the human acceptance checks in this conversation that nobody has reviewed yet. A check that you already approved is not listed again. Use it when you were woken about a check, or before reporting that a task is waiting only on the user.',
      parameters: Type.Object({}),
      available: main && Boolean(features.supervisor?.pendingHumanChecks && features.supervisor?.reviewHumanCheck),
      externallyGated: false,
    },
    review_human_check: {
      name: 'review_human_check', label: 'Review a human acceptance check', description: 'Record your look at one human acceptance check, before the user is asked. approve:true means the evidence looks right and the user should be asked (your review is attached); approve:false means it should not have been raised, so send the node back for rework instead. This is NOT acceptance: the check stays open and the user still has to pass it themselves. Approving twice writes nothing and returns false.',
      parameters: Type.Object({
        questionId: Type.String(),
        approve: Type.Boolean(),
        note: Type.String(),
        requestId: Type.String(),
      }),
      available: main && Boolean(features.supervisor?.pendingHumanChecks && features.supervisor?.reviewHumanCheck),
      externallyGated: false,
    },
    ask_user: {
      name: 'ask_user', label: 'Ask the user', description: 'Ask the user the one question whose answer changes the plan, then end this turn and wait for it. Write prompt and why in Markdown. When useful, offer concise options and set multiple true only when several choices can be selected together; the user can always write a custom answer. The answer arrives in your next turn as a recorded fact. Use it when the project, confirmed scope and recorded decisions cannot settle the choice.',
      parameters: Type.Object({
        prompt: Type.String(),
        why: Type.String(),
        options: Type.Optional(Type.Array(Type.String())),
        multiple: Type.Optional(Type.Boolean()),
        requestId: Type.String(),
      }),
      available: main && Boolean(features.supervisor?.controlTask),
      externallyGated: false,
    },
    conversation_read: {
      name: 'conversation_read', label: 'Read another conversation', description: 'Read another conversation: its transcript, the conversations that exist, or the events since a cursor. This is how a session follows work it handed to somebody else. follow returns what happened after the cursor you pass, so call it again with the highest cursor you saw to continue. Reading is not an authority over the other session: the user still owns it.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('read'), Type.Literal('follow')]),
        conversationId: Type.Optional(Type.String()),
        after: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
        archived: Type.Optional(Type.Boolean()),
      }),
      available: Boolean(features.conversations?.read),
      externallyGated: false,
    },
    conversation_write: {
      name: 'conversation_write', label: 'Write into another conversation', description: 'Hand work to another conversation: send a message, steer a running turn with one (the text is queued, then pushed into the turn that is already running), or pause/resume it. Needs full access, and may only address other conversations; beyond that agents talk freely — a reply back is a message rather than a bounce, and one turn may hand out as many as it needs. The message arrives marked as coming from another Agent, never as the user, so report progress to the user instead of broadcasting.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('send'), Type.Literal('steer'), Type.Literal('pause'), Type.Literal('resume')]),
        conversationId: Type.String(),
        text: Type.Optional(Type.String()),
        requestId: Type.String(),
      }),
      available: Boolean(features.conversations?.write),
      externallyGated: false,
    },
    control_task: {
      name: 'control_task', label: 'Control a task', description: 'Control the task you are serving, or another task of the same conversation. pause soft-stops the running turn and waits for an explicit resume; resume continues it; abandon stops the whole task immediately (it is refused while a worker lane is still writing to the target, so pause first when work is in flight); set_budget sets one node budget as a positive token count or null for unlimited (null is what a master node normally runs with: a finite cap must still cover the context reservation of that node, so a small cap starves the instance it was meant to help); steer injects one message into the turn currently running on a node. Every action records its reason, and abandoning work the user still expects is never right.',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('pause'), Type.Literal('resume'), Type.Literal('abandon'), Type.Literal('set_budget'), Type.Literal('steer'),
        ]),
        taskId: Type.Optional(Type.String()),
        nodeId: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        tokens: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        reason: Type.Optional(Type.String()),
        requestId: Type.String(),
      }),
      available: main && Boolean(features.supervisor?.controlTask),
      externallyGated: false,
    },
    search_resources: {
      name: 'search_resources', label: 'Search capability library', description: 'Search the user capability directory (Skills, MCP servers, Pi extensions, Graph extensions and prompt identities). Search results are discovery only; bind a capability into a versioned Agent recipe or definition to make its tools available to that Agent.',
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        kind: Type.Optional(Type.String()),
        role: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number()),
      }),
      available: main && Boolean(features.catalog),
      externallyGated: false,
    },
    get_resource: {
      name: 'get_resource', label: 'Get capability details', description: 'Read one capability returned by search_resources by id or id@version. This never reads Agent recipes or definitions; use get_agent_combination with the recipe id (for example coder, not coder@5). Reading details does not bind the capability.',
      parameters: Type.Object({ id: Type.String(), version: Type.Optional(Type.String()) }),
      available: main && Boolean(features.catalog),
      externallyGated: false,
    },
    read_system_capabilities: {
      name: 'read_system_capabilities', label: 'Read system capabilities', description: 'Read configuration inventory: redacted subscription plans, model connections, current Agent recipes, compiled Agent definitions, graph architectures and quota windows. Secret values are never included. Use this before choosing a model, assembling subagents or claiming that something is available.',
      parameters: Type.Object({}),
      available: main && Boolean(features.systemContext?.systemSummary),
      externallyGated: false,
    },
    inspect_graph_system: {
      name: 'inspect_graph_system', label: 'Inspect Graph health', description: 'Inspect runtime health for this conversation only: invalid capabilities, open internal problems, failed nodes, unknown-usage records, artifact counts and pending system changes. Configuration inventories are returned by read_system_capabilities, not duplicated here.',
      parameters: Type.Object({}),
      available: main && Boolean(features.systemContext?.systemDiagnostics),
      externallyGated: false,
    },
    propose_system_change: {
      name: 'propose_system_change', label: 'Propose system change', description: 'Propose a Graph system change for explicit user approval. Include the exact machine-readable change; see docs/agent/self-configuration.md for the supported shapes.',
      parameters: Type.Object({
        title: Type.String(),
        problem: Type.String(),
        changeJson: Type.String(),
        impact: Type.Optional(Type.String()),
        risk: Type.Optional(Type.String()),
      }),
      available: main && Boolean(features.systemContext?.proposeSystemChange),
      externallyGated: false,
    },
    apply_system_change: {
      name: 'apply_system_change', label: 'Apply approved system change', description: 'Apply one previously proposed system change, and only after the user approved its question.',
      parameters: Type.Object({ proposalId: Type.String() }),
      available: main && Boolean(features.systemContext?.applySystemChange),
      externallyGated: false,
    },
    inspect_rsi_status: {
      name: 'inspect_rsi_status', label: 'Inspect self-improvement status', description: 'Read the Recursive Self-Improvement surface for Graph itself: the source checkout root, current branch, any pending restart, how many operations are still running, and the in-flight operation identities (id, task, node, request, archived). It also reports which local branches are ahead of the copy they were published to (`sync.unpublished`), which ones are self-improvement work lines that are never published by design (`sync.expected`), how many were never published (`sync.localOnly`), and how the checkout the app runs from compares to the development checkout of the same repository (`sync.deploy`: which files differ, which the development line has and this checkout lacks, and how many of those are under `src/`), compared against the remote-tracking refs known locally. Use it before changing the harness, to see whether a previous change is waiting to reload, and to notice unpublished work: a push channel that quietly stopped working shows up there and nowhere else.',
      parameters: Type.Object({}),
      available: main && Boolean(features.rsi?.status),
      externallyGated: false,
    },
    apply_rsi_change: {
      name: 'apply_rsi_change', label: 'Apply self-improvement change', description: 'Change Graph itself: edit, add or delete files in the Graph source checkout, run checks, commit to a dedicated rsi/* branch and (when activate is true) schedule a reload. Use it for any harness improvement you can justify, not only bugs. Every change needs a repository-relative path, whatever its action: action "write" (full content), "replace" (each oldText must match exactly once in that file), "copy" (the file becomes exactly that revision\'s content - use it to mirror a file from another branch or checkout instead of retyping it, since a retyped file silently drops lines) or "delete" - one entry per file, shaped {path, action, content}, {path, action, edits: [{oldText, newText}]}, {path, action: "copy", from: "<revision>"} or {path, action: "delete"}. Supply checks for a fast inner loop; the full `node --run check` and `app:build` gate runs before a change goes live. If checks fail the change stays uncommitted so you can keep fixing; pass changes: [] to just re-run checks. activate=true ends this operation and leaves the change pending_reload, so do not start another improvement while a reload is pending. force reloads even while other operations run.',
      parameters: Type.Object({
        title: Type.String(),
        problem: Type.String(),
        evidence: Type.Optional(Type.String()),
        diagnosis: Type.Optional(Type.String()),
        impact: Type.Optional(Type.String()),
        risk: Type.Optional(Type.String()),
        changes: Type.Optional(Type.Array(Type.Object({
          path: Type.String({ description: 'Repository-relative file this change writes, replaces or deletes.' }),
          action: Type.String(),
          content: Type.Optional(Type.String()),
          from: Type.Optional(Type.String({ description: 'Revision to copy the file from, for action "copy" (for example the commit of the branch you are mirroring).' })),
          edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }))),
        }))),
        checks: Type.Optional(Type.Array(Type.Object({ command: Type.String(), args: Type.Array(Type.String()) }))),
        activate: Type.Optional(Type.Boolean()),
        force: Type.Optional(Type.Boolean()),
      }),
      available: main && Boolean(features.rsi?.apply),
      externallyGated: false,
      ...(rsiArguments ? { prepareArguments: rsiArguments } : {}),
    },
    list_peers: {
      name: 'list_peers', label: 'List peer Agents', description: 'List the other Agents of THIS graph with their status, so you can address one by id. A subagent may only talk to nodes of its own graph; naming another graph is refused. Together with send_to_peer this is how the Agents of one graph work together instead of each guessing what the others are doing.',
      parameters: Type.Object({}),
      available: Boolean(features.peers),
      externallyGated: false,
    },
    send_to_peer: {
      name: 'send_to_peer', label: 'Send a message to a peer Agent', description: 'Send a durable message to another Agent of this graph. The message triggers a reply when the peer is idle; while it is busy, the message queues for a later serial turn in the same conversation. It appears in the peer chat window. The peer does not have to be running now. A retried requestId is the same message, not a second one. Only nodes of your own graph are reachable.',
      parameters: Type.Object({
        to: Type.String(),
        text: Type.String(),
        requestId: Type.String(),
      }),
      available: Boolean(features.peers),
      externallyGated: false,
    },
    list_agent_combinations: {
      name: 'list_agent_combinations', label: 'List Agent combinations', description: 'List subagent recipes composed from shared resource-library IDs. Results are recipes, not installed definitions or permissions; inspect the referenced resources before using one.',
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        grade: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      available: main && Boolean(features.catalog),
      externallyGated: false,
    },
    get_agent_combination: {
      name: 'get_agent_combination', label: 'Get Agent combination', description: 'Resolve one subagent recipe to its source resources. This does not install, compose or authorize anything; use the returned resources and their metadata to prepare the required capabilities. When you present that Agent to the user, keep its readable name (for example Bob_coder) and pair it with the stable recipe id.',
      parameters: Type.Object({ id: Type.String() }),
      available: main && Boolean(features.catalog),
      externallyGated: false,
    },
  } as const satisfies Record<string, Declaration>;
}

export type AgentToolName = keyof ReturnType<typeof declarations>;

export function describeAgentTools(features: AgentToolFeatures): (AgentToolDeclaration & { name: AgentToolName })[] {
  return Object.values(declarations(features)).filter(tool => tool.available);
}
