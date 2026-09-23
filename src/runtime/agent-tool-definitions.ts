import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Facts about the host bindings, without executors or filesystem access. */
export interface AgentToolFeatures {
  role?: string;
  readOnly?: boolean;
  run?: boolean;
  fetch?: boolean;
  catalog?: boolean;
  artifacts?: { allowedNamespaces: readonly string[]; canPromote: boolean };
  supervisor?: Partial<Record<'validateProposal' | 'graphState' | 'taskStatus' | 'listProjects' | 'bindProject' | 'listProblems' | 'resolveProblem', boolean>>;
  systemContext?: Partial<Record<'systemSummary' | 'systemDiagnostics' | 'proposeSystemChange' | 'applySystemChange' | 'requestModelAccess', boolean>>;
  rsi?: Partial<Record<'status' | 'apply', boolean>>;
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

type Declaration = Pick<ToolDefinition, 'name' | 'label' | 'description' | 'parameters'> & {
  available: boolean;
  externallyGated: boolean;
};

// Schemas, descriptions and registration conditions are shared by previews and
// execution. Constructing declarations never resolves paths or invokes a tool.
function declarations(features: AgentToolFeatures) {
  const main = features.role === 'master';
  return {
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
    artifact_list: {
      name: 'artifact_list',
      label: 'List shared artifacts',
      description: 'List published task artifacts. This is the discovery surface for literature sets, plans, review reports and deliverables; it returns metadata only. Use artifact_read for bounded content.',
      parameters: Type.Object({
        namespace: Type.Optional(Type.String()),
        prefix: Type.Optional(Type.String()),
        schema: Type.Optional(Type.String()),
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
      description: `Publish an immutable artifact version from a file inside this Agent's private workspace or from direct text content. Allowed namespaces: ${(features.artifacts?.allowedNamespaces ?? []).join(', ')}. Publishing never overwrites an earlier version; use expectedVersion for compare-and-swap.`,
      parameters: Type.Object({
        namespace: Type.String(),
        name: Type.String(),
        sourcePath: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        mediaType: Type.Optional(Type.String()),
        schema: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        expectedVersion: Type.Optional(Type.Number()),
        requestId: Type.String(),
      }),
      available: Boolean(features.artifacts),
      externallyGated: false,
    },
    artifact_retire: {
      name: 'artifact_retire',
      label: 'Retire shared artifact version',
      description: 'Retire one published artifact version without deleting its immutable bytes. Use only when a version is superseded or withdrawn; existing evidence and handoff references remain explainable.',
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
    submit_result: {
      name: 'submit_result', label: 'Submit result', description: 'Submit structured JSON output for this operation.',
      parameters: Type.Object({ outputJson: Type.String() }),
      available: features.role !== 'master',
      externallyGated: false,
    },
    run_command: {
      name: 'run_command', label: 'Run command', description: 'Run an allowed command inside the work copy: command is a bare executable name (node or git) and args is a string array, for example {command:"node",args:["--test","test/x.test.js"]}. It is not a shell; git only supports read-only status/diff/log/show.',
      parameters: Type.Object({ command: Type.String(), args: Type.Optional(Type.Array(Type.String())) }),
      available: Boolean(features.run && !features.readOnly),
      externallyGated: true,
    },
    git_status: {
      name: 'git_status', label: 'Git status', description: 'Read the current work copy branch and working-tree status. This is read-only.',
      parameters: Type.Object({}),
      available: Boolean(features.run && !features.readOnly),
      externallyGated: true,
    },
    git_diff: {
      name: 'git_diff', label: 'Git diff', description: 'Read the current work copy diff. Optionally select staged changes, a base revision, a path or summary/stat output. This is read-only.',
      parameters: Type.Object({
        staged: Type.Optional(Type.Boolean()),
        base: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        stat: Type.Optional(Type.Boolean()),
      }),
      available: Boolean(features.run && !features.readOnly),
      externallyGated: true,
    },
    git_log: {
      name: 'git_log', label: 'Git log', description: 'Read recent commits from the current work copy. This is read-only.',
      parameters: Type.Object({
        limit: Type.Optional(Type.Number()),
        path: Type.Optional(Type.String()),
      }),
      available: Boolean(features.run && !features.readOnly),
      externallyGated: true,
    },
    git_show: {
      name: 'git_show', label: 'Git show', description: 'Read one commit or object from the current work copy. Optionally request summary/stat output or limit to one path. This is read-only.',
      parameters: Type.Object({
        ref: Type.Optional(Type.String()),
        stat: Type.Optional(Type.Boolean()),
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
      name: 'propose_graph', label: 'Propose graph', description: 'Submit a validated task graph proposal for the user to confirm. proposalJson is a JSON object with requirementVersion, summary, acceptance[{id,description,checkNode}], nodes[NodeSpec], optional containers, loops and decisions. Agent nodes require definitionVersion and model; every acceptance checkNode must reference a mandatory program node. Keep decisions current: they are frozen with this draft version and passed to workers after confirmation.',
      parameters: Type.Object({ proposalJson: Type.String(), requestId: Type.String() }),
      available: main && Boolean(features.supervisor),
      externallyGated: false,
    },
    revise_graph: {
      name: 'revise_graph', label: 'Revise graph', description: 'Revise the confirmed task graph without changing acceptance items. nodesJson is a JSON array of NodeSpec objects using id, kind, action, dependsOn, input, definitionVersion, model, context and verifier fields as applicable. Supply every surviving node verbatim: any node whose spec differs from the current version is reworked, so copy unchanged nodes back exactly or you will restart work you did not mean to touch. Every node you leave out must also be named in retire, otherwise the revision is refused with the ids it is missing: dropping a node is a deliberate act, never a side effect of an incomplete list. Pass taskId to revise a feature task this conversation created instead of this conversation own task; the task must belong to the same conversation.',
      parameters: Type.Object({ baseVersion: Type.Number(), reason: Type.String(), nodesJson: Type.String(), retire: Type.Optional(Type.Array(Type.String())), requestId: Type.String(), taskId: Type.Optional(Type.String()) }),
      available: main && Boolean(features.supervisor),
      externallyGated: false,
    },
    validate_proposal: {
      name: 'validate_proposal', label: 'Validate graph proposal', description: 'Validate one task graph proposal against the current requirement version and Graph structural rules without creating a draft or dispatching work. Returns valid:true or a concrete validation error.',
      parameters: Type.Object({ proposalJson: Type.String() }),
      available: main && Boolean(features.supervisor?.validateProposal),
      externallyGated: false,
    },
    get_graph_state: {
      name: 'get_graph_state', label: 'Get graph state', description: 'Read the current proposal, graph revision, phase, node statuses, evidence, worktrees and internal problems for this conversation. Use this instead of guessing progress from chat history or the injected briefing.',
      parameters: Type.Object({}),
      available: main && Boolean(features.supervisor?.graphState),
      externallyGated: false,
    },
    get_task_status: {
      name: 'get_task_status', label: 'Get task status', description: 'Read a compact status of one task: phase, graph version, per-node status with the model that actually runs it, open user questions, open internal problems and which acceptance evidence is currently valid. Much smaller than get_graph_state, so prefer it while polling. Pass nodeId to also get that node full input (useful before revising it), and waitForNode plus timeoutMs to block until that node settles or something needs you instead of polling yourself.',
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
      name: 'list_projects', label: 'List projects', description: 'List the projects currently configured in Graph, including their preparation state. Use this before asking the user to choose a project.',
      parameters: Type.Object({}),
      available: main && Boolean(features.supervisor?.listProjects),
      externallyGated: false,
    },
    bind_project: {
      name: 'bind_project', label: 'Bind project', description: 'Bind this conversation to one configured and prepared project. Binding a different project invalidates the current graph draft and requires a fresh investigation.',
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
      name: 'propose_system_change', label: 'Propose system change', description: 'Propose a Graph system optimization for explicit user approval. This does not change configuration. Include the exact machine-readable change. Supported change.kind is currently "capability" with change.capability = { manifest, files?, overwrite? }. Use it when the user asks to install/update a capability or when diagnostics reveal a system defect.',
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
      name: 'apply_system_change', label: 'Apply approved system change', description: 'Apply one previously proposed system change only after the user approved its system_change question. Approval and proposal data are checked by the host; this tool cannot bypass the user decision.',
      parameters: Type.Object({ proposalId: Type.String() }),
      available: main && Boolean(features.systemContext?.applySystemChange),
      externallyGated: false,
    },
    inspect_rsi_status: {
      name: 'inspect_rsi_status', label: 'Inspect self-improvement status', description: 'Read the Recursive Self-Improvement surface for Graph itself: the source checkout root, current branch, any pending restart, how many operations are still running, and the in-flight operation identities (id, task, node, request, archived). Use it before changing the harness and to see whether a previous change is waiting to reload.',
      parameters: Type.Object({}),
      available: main && Boolean(features.rsi?.status),
      externallyGated: false,
    },
    apply_rsi_change: {
      name: 'apply_rsi_change', label: 'Apply self-improvement change', description: 'Change Graph itself: edit, add or delete files in the Graph source checkout, run checks, commit to a dedicated rsi/* branch and (when activate is true) schedule a reload. Use it for any harness improvement you can justify, not only bugs. Each file needs action "write" (full content), "replace" (each oldText must match exactly once) or "delete". Supply checks for a fast inner loop; the full `node --run check` and `app:build` gate runs before a change goes live. If checks fail the change stays uncommitted so you can keep fixing; pass changes: [] to just re-run checks. activate=true ends this operation and leaves the change pending_reload, so do not start another improvement while a reload is pending. force reloads even while other operations run.',
      parameters: Type.Object({
        title: Type.String(),
        problem: Type.String(),
        evidence: Type.Optional(Type.String()),
        diagnosis: Type.Optional(Type.String()),
        impact: Type.Optional(Type.String()),
        risk: Type.Optional(Type.String()),
        changes: Type.Optional(Type.Array(Type.Object({
          path: Type.String(),
          action: Type.String(),
          content: Type.Optional(Type.String()),
          edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }))),
        }))),
        checks: Type.Optional(Type.Array(Type.Object({ command: Type.String(), args: Type.Array(Type.String()) }))),
        activate: Type.Optional(Type.Boolean()),
        force: Type.Optional(Type.Boolean()),
      }),
      available: main && Boolean(features.rsi?.apply),
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
      name: 'get_agent_combination', label: 'Get Agent combination', description: 'Resolve one subagent recipe to its source resources. This does not install, compose or authorize anything; use the returned resources and their metadata to prepare the required capabilities.',
      parameters: Type.Object({ id: Type.String() }),
      available: main && Boolean(features.catalog),
      externallyGated: false,
    },
    save_agent_combination: {
      name: 'save_agent_combination', label: 'Save and compile Agent combination', description: 'Create or edit an Agent recipe, then validate and compile it immediately into a versioned Agent definition. A recipe may reference only capabilities that already exist; saving never creates capabilities or grants permission. Use the returned definitionVersion directly in propose_graph.',
      parameters: Type.Object({ combinationJson: Type.String() }),
      available: main && Boolean(features.catalog),
      externallyGated: false,
    },
    update_agent_combination_description: {
      name: 'update_agent_combination_description', label: 'Update Agent combination description', description: 'Edit only one Agent recipe description and immediately persist and recompile it. Use this when the user asks to improve how a subagent is described or when a clearer description would help future subagent selection; it does not change capabilities, permissions or resources.',
      parameters: Type.Object({ id: Type.String(), description: Type.String() }),
      available: main && Boolean(features.catalog),
      externallyGated: false,
    },
    delete_agent_combination: {
      name: 'delete_agent_combination', label: 'Delete Agent combination', description: 'Delete one user-editable Agent recipe. This never removes referenced capabilities.',
      parameters: Type.Object({ id: Type.String() }),
      available: main && Boolean(features.catalog),
      externallyGated: false,
    },
    request_model_access: {
      name: 'request_model_access', label: 'Request model access', description: 'Open one durable user question asking for a model or subscription to be configured. This never edits configuration and never grants permission automatically. Use it only when the current task needs a model that read_system_capabilities shows as unavailable.',
      parameters: Type.Object({ modelId: Type.String(), reason: Type.String(), planId: Type.Optional(Type.String()) }),
      available: main && Boolean(features.systemContext?.requestModelAccess),
      externallyGated: false,
    },
  } as const satisfies Record<string, Declaration>;
}

export type AgentToolName = keyof ReturnType<typeof declarations>;

export function describeAgentTools(features: AgentToolFeatures) {
  return Object.values(declarations(features)).filter(tool => tool.available);
}
