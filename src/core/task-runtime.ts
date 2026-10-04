import { sendNodeMessage, sendPeerMessage } from './node-messages.ts';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { closePause, closeUserWait, openPause } from './time-ledger.ts';
import { activeOperationForNode } from './control-targets.ts';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { TaskStore, canonicalJson } from './store.ts';
import { ArtifactWorkspace } from './artifact-workspace.ts';
import {
  appendMessage,
  cancelQueuedMessage,
  conversationForTask,
  conversationMasterUsage,
  conversationRow,
  conversationStreams,
  deliverMessages,
  listMessages,
  pendingMessages,
  type MessageRow,
} from './conversation.ts';
import { Execution } from './execution.ts';
import { createMergeResolver } from './merge-resolver.ts';
import { isFullAccess, resolveAccessPolicy, standardAccessPolicy, type AccessPolicy, type ResolvedAccessPolicy } from './access-policy.ts';
import { contextView } from './context.ts';
import { setBudget } from './budget-ledger.ts';
import { awaitPauseContinuation, resumePauseContinuations } from './pause-continuation.ts';
import { acquireOwner } from './owner.ts';
import { materializeGraph } from './confirm-graph.ts';
import { KernelStore } from './kernel-store.ts';
import { parseGraphDefinition } from './interface-spec.ts';
import { DEFAULT_V2_RESERVE_TOKENS, kernelGraphLane } from '../runtime/kernel-graph-lane.ts';
import { NodeSubmitBridge } from './node-submit-bridge.ts';
import { validateProposal } from './proposal.ts';
import { createActivation, hasLockedQuestion, loadGraph } from './graph.ts';
import { applyRevision } from './revision.ts';
import { nodeRun as nodeRunView } from './node-run.ts';
import { nodePromptView } from './node-prompt.ts';
import { renderPredecessorHandoffs } from './predecessor-handoff.ts';
import { operationSnapshots } from './operation-lifecycle.ts';
import { clearToolCallSpools, ingestToolCallSpools } from '../runtime/tool-call-spool.ts';
import { skillUsage } from '../runtime/skill-usage.ts';
import { promoteSkillFromProjects } from '../runtime/skill-promotion.ts';
import { sedimentSettings } from '../runtime/sediment.ts';
import { piExtensionSourceStatus, updatePiExtensionSource, type PiExtensionUpdate } from '../runtime/pi-extension-source.ts';
import { syncCapabilityVersion, piExtensionCacheDir } from '../runtime/capabilities.ts';
import { approveHumanCheck, humanCheckPreReview, insertQuestion, pendingHumanChecks, problemActions, questionSummary, recoverMaster } from './question-routing.ts';
import { talentDetail, talentExperience } from './talent.ts';
import { Catalog, type DefinitionSpec } from '../catalog/catalog.ts';
import { mergeCosts, sumCosts, type ModelEntry } from '../catalog/models.ts';
import { createPiAdapter, type PiAdapterChannels } from '../runtime/pi-adapter.ts';
import { effectiveThinkingLevel, thinkingOptionsFor } from '../runtime/thinking.ts';
import { GitIntegration } from '../git/integration.ts';
import { invocationRows } from '../runtime/task-gate.ts';
import { createModelScheduler, type ModelScheduler } from '../runtime/model-scheduler.ts';
import type { AgentContextLibrary } from '../runtime/agent-context.ts';
import { openAgentContextAssembly } from '../runtime/agent-context-assembly.ts';
import { agentSkillOwnedRoots, agentSkillsDir } from '../runtime/agent-skills.ts';
import { agentArtifactAccess } from '../runtime/agent-tool-definitions.ts';
import type { RsiChangeInput, RsiService } from '../runtime/rsi.ts';
import type { MergeResolverChannels } from './execution.ts';
import type { ActionAdapter, Answer, EvidenceInput, Json, Operation, OperationResult } from './types.ts';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RuntimeError, type AttachmentInput, type ProjectConfig, type Proposal, type ProposalReceipt, type Receipt, type NodeSpec, type TaskUpdate, type TaskWatch } from './types.ts';
import { cleanAttachments, isImageAttachment } from './attachments.ts';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Bounds for the compatibility decision snapshot.
 *
 * When the master declares no decisions the harness freezes the conversation's consumed user
 * messages instead. That is deliberate: it is how a constraint the user states in chat reaches the
 * node doing the work (pinned by tests/m8/conversation.test.ts). But it had no bound, so one real
 * task carried 636 entries of its whole chat history into every node.
 *
 * The window keeps BOTH ends. Dropping the oldest instead would defeat the feature, because the
 * original request and the constraints stated with it are the oldest messages there are.
 */
const DECISION_DIGEST_MAX_MESSAGES = 20;

/**
 * Whether a user message says anything worth carrying into every node's briefing.
 *
 * The fallback exists so a constraint the user states in chat reaches the worker, and that is exactly
 * why it cannot be a length rule: "别动 login" is shorter than "好的，继续吧" and is the kind of line the
 * fallback is for. What it can drop is a message that states no decision at all - a slash command, or a
 * bare acknowledgement or continuation - because those cost window space in every briefing while reading
 * like a constraint to a model that is looking for one (HB-190).
 */
export function statesADecision(text: string) {
  const bare = text.trim().replace(/[。.!！？?，,、;；:：\s]+$/u, '').trim();
  if (!bare) return false;
  if (bare.startsWith('/')) return false;
  return !/^(?:continue|go on|ok(?:ay)?|yes|yep|thanks|thank you|继续|接着(?:做|干)?|好的|好|是|是的|对|可以|行|收到|谢谢|多谢)$/i.test(bare);
}
const DECISION_DIGEST_HEAD = 6;
const DECISION_DIGEST_TAIL = DECISION_DIGEST_MAX_MESSAGES - DECISION_DIGEST_HEAD;
const DECISION_DIGEST_MAX_CHARS = 4_000;

function asThinkingLevel(value: string): ThinkingLevel {
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new RuntimeError('invalid_input', 'A valid thinking level is required');
  return value as ThinkingLevel;
}

function steeringText(row: MessageRow) {
  const parts = row.text.trim() ? [row.text.trim()] : [];
  if (row.data) {
    try {
      const data = JSON.parse(row.data) as { attachments?: unknown };
      if (Array.isArray(data.attachments)) {
        for (const value of data.attachments) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const attachment = value as { name?: unknown; text?: unknown; type?: unknown; data?: unknown; size?: unknown };
          if (typeof attachment.name !== 'string') continue;
          if (typeof attachment.text === 'string' && attachment.text.trim()) {
            parts.push(`附件 ${attachment.name}:\n${attachment.text}`);
          } else if (isImageAttachment({
            name: attachment.name,
            type: typeof attachment.type === 'string' ? attachment.type : 'image/png',
            size: typeof attachment.size === 'number' ? attachment.size : 0,
            text: '',
            ...(typeof attachment.data === 'string' ? { data: attachment.data } : {}),
          })) {
            // Steering is text-only today; keep the image visible by name
            // instead of silently dropping the reference.
            parts.push(`附件 ${attachment.name}（图片，请在发送消息中查看）`);
          }
        }
      }
    } catch {
      // A malformed legacy data field must not make a textual steering message unusable.
    }
  }
  return parts.join('\n\n');
}

interface ProposalRow {
  version: number;
  requirement_version: number;
  spec: string;
  decision_snapshot: string | null;
}

/** A revision names its target explicitly. Without one it revises this
 * conversation own task; with one it may revise a feature task the same
 * conversation created, never a task from another conversation. */
function conversationTarget(store: TaskStore, supervisorTaskId: string, requested: string | undefined, what: string) {
  if (requested === undefined || requested === supervisorTaskId) return supervisorTaskId;
  const self = store.db.prepare('SELECT conversation_id FROM tasks WHERE id=?').get(supervisorTaskId) as { conversation_id: string | null } | undefined;
  const target = store.db.prepare('SELECT conversation_id FROM tasks WHERE id=?').get(requested) as { conversation_id: string | null } | undefined;
  if (!target || !self?.conversation_id || target.conversation_id !== self.conversation_id) {
    throw new RuntimeError('invalid_input', `${what} may only target a task of this conversation`);
  }
  return requested;
}

function revisionTarget(store: TaskStore, supervisorTaskId: string, requested: string | undefined) {
  if (requested !== undefined) return conversationTarget(store, supervisorTaskId, requested, 'A revision');
  // Without taskId the default is the supervisor's own (anchor) task, which can never be revised -
  // it has no confirmed proposal - so the call failed with a message about requirements. When this
  // conversation has exactly one live feature task, that is plainly the target; anything else stays
  // ambiguous and keeps the old default rather than guessing.
  const live = store.db.prepare(`SELECT id FROM tasks
    WHERE conversation_id=(SELECT conversation_id FROM tasks WHERE id=?) AND id<>? AND phase IN ('running','queued')`)
    .all(supervisorTaskId, supervisorTaskId) as { id: string }[];
  return live.length === 1 ? live[0]!.id : supervisorTaskId;
}

// A compact projection of one task: which node runs what, what still runs, what needs the user and
// which acceptance evidence is currently valid. `graphState` carries the same information at roughly
// ten times the size, so this is the read to poll with.
function taskStatusView(store: TaskStore, taskId: string, nodeId?: string) {
  const task = store.task(taskId);
  const nodes = store.db.prepare(`SELECT n.id,n.spec,n.status,n.stall_count,i.model,i.definition_version
    FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid`).all(taskId) as {
      id: string; spec: string; status: string; stall_count: number; model: string | null; definition_version: string | null;
    }[];
  const selected = nodeId === undefined ? nodes : nodes.filter(row => row.id === nodeId);
  if (nodeId !== undefined && !selected.length) throw new RuntimeError('not_found', `Task ${taskId} has no node ${nodeId}`);
  const questions = store.db.prepare("SELECT id,node_id,kind,owner FROM questions WHERE task_id=? AND status='open' ORDER BY rowid").all(taskId) as {
    id: string; node_id: string; kind: string; owner: string;
  }[];
  const evidence = store.db.prepare('SELECT node_id,data,valid,commit_sha FROM evidence WHERE task_id=? ORDER BY rowid').all(taskId) as {
    node_id: string; data: string; valid: number; commit_sha: string | null;
  }[];
  const current = new Map<string, { acceptanceId: string; nodeId: string; valid: boolean; commitSha?: string }>();
  for (const row of evidence) {
    const data = JSON.parse(row.data) as EvidenceInput;
    current.set(data.acceptanceId, {
      acceptanceId: data.acceptanceId, nodeId: row.node_id, valid: Boolean(row.valid),
      ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    });
  }
  const userQuestions = questions.filter(question => question.owner === 'user');
  return {
    taskId,
    phase: task.phase,
    status: task.paused ? 'paused' : userQuestions.length ? 'blocked' : task.phase,
    graphVersion: task.graph_version,
    proposalVersion: task.latest_proposal,
    acceptedProposalVersion: task.accepted_proposal,
    targetBranch: task.target_branch,
    integrationSha: task.integration_sha,
    nodes: selected.map(row => {
      const spec = JSON.parse(row.spec) as NodeSpec;
      // A node reset by a revision is pending again while its old instance still carries the
      // previous model, so the spec decides until the node is dispatched once more.
      const model = row.status === 'pending' ? spec.model ?? row.model : row.model ?? spec.model;
      return {
        id: row.id, kind: spec.kind, action: spec.action, status: row.status,
        ...(model ? { model } : {}),
        ...(row.definition_version ? { definition: row.definition_version } : {}),
        ...(row.stall_count ? { stallCount: row.stall_count } : {}),
        ...(nodeId === undefined ? {} : { input: spec.input }),
      };
    }),
    questions: userQuestions.map(question => ({ id: question.id, nodeId: question.node_id, kind: question.kind })),
    problems: questions.filter(question => question.owner === 'main')
      .map(question => ({ id: question.id, nodeId: question.node_id, kind: question.kind })),
    evidence: [...current.values()],
  };
}

function conversationProposal(store: TaskStore, taskId: string, version: number, currentRequirementVersion: number) {
  const row = store.db.prepare('SELECT version,requirement_version,spec,decision_snapshot FROM proposals WHERE task_id=? AND version=?')
    .get(taskId, version) as ProposalRow | undefined;
  if (!row) return null;
  return {
    version: row.version,
    requirementVersion: row.requirement_version,
    stale: row.requirement_version !== currentRequirementVersion,
    spec: JSON.parse(row.spec) as Proposal,
    decisions: row.decision_snapshot,
  };
}

export async function openTaskRuntime(options: {
  stateDir: string;
  projects?: ProjectConfig[];
  actions?: Record<string, ActionAdapter>;
  models?: {
    entries: ModelEntry[];
    preferences?: Partial<Record<ModelEntry['grade'], string[]>>;
    /** Legacy single key; used for entries without a credential binding. */
    apiKey?: string;
    modelRuntime: ModelRuntime;
    /** Per-model credential binding so aliases never share or cross keys. */
    credentialFor?: (entry: ModelEntry) => { credentialId: string; apiKey: string; limit?: number; sharedGroupId?: string; groupLimit?: number } | undefined;
    /** Shared scheduler; one is created per runtime when omitted. */
    modelScheduler?: ModelScheduler;
  };
  /** Config version recorded with new tasks so history points at its binding. */
  config?: { revision(): number };
  master?: { action: string; definitionVersion: string | (() => string | undefined); model: string | (() => string | undefined) };
  network?: { retrievalDomains?: string[]; mcpDomains?: string[] };
  /** Hot-reloadable APP/keychain values used only for declared MCP config refs. */
  capabilitySecrets?: () => Record<string, string>;
  /** Default per-instance budget for new instances. null/absent means no
   * cumulative token cap; a positive integer keeps the finite-budget gate. */
  limits?: { defaultBudgetTokens?: number | null };
  /** Hot-reloadable access policy used for the next admitted operation. */
  access?: () => AccessPolicy | undefined;
  /** Hot-reloadable configuration view. When present, entries, preferences,
   * credential bindings, master model, projects and default budget are read
   * per use instead of from the static options captured at startup. */
  live?: {
    revision(): number;
    /** The raw config snapshot: the sediment switch is read from here on every turn. */
    config(): unknown;
    entries(): ModelEntry[];
    preferences(): Partial<Record<ModelEntry['grade'], string[]>>;
    credentialFor(entry: ModelEntry): { credentialId: string; apiKey: string; limit?: number; sharedGroupId?: string; groupLimit?: number } | undefined;
    masterModel(): string | undefined;
    defaultBudgetTokens(): number | null;
    projects?(): ProjectConfig[];
  };
  /** Host-selected grants and environment for confirmed program checks only.
   * Without `nodeModulesPath` a check links the project root's own installed
   * dependencies, so the project toolchain resolves in an isolated work copy. */
  program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string };
  /** Read-only host inventory exposed to the master Agent. It must never
   * contain secret values or write configuration on the Agent's behalf. */
  systemContext?: {
    systemSummary?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  };
  /** Recursive Self-Improvement: lets the Main Agent change the Graph source
   * checkout it is running from, verify the change and schedule a reload. */
  rsi?: RsiService;
  /**
   * How a collision between two lanes is handed to an Agent. The harness still decides whether
   * the resolution is acceptable; this only supplies the turn that proposes one. Omitting it
   * keeps the previous behaviour, which is to block the task with `git_conflict`.
   */
  mergeResolvers?: MergeResolverChannels;
  /** User-owned capability and recipe files. The desktop daemon passes ~/.graph. */
  catalog?: {
    capabilityRoot?: string;
    recipesPath?: string;
    bootstrapPrompts?: Record<string, string>;
    bootstrapToolPrompt?: string;
  };
  /** User-editable prompt overrides and Main Agent tool selection. */
  agentContext?: AgentContextLibrary;
  /** UI-hosted daemons wake dispatch as soon as a conversation message is queued. */
  autoWake?: boolean;
}) {
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(options.stateDir);
  const releaseOwner = acquireOwner(join(stateDir, 'owner.sqlite'));
  let store: TaskStore;
  try { store = new TaskStore(join(stateDir, 'tasks.sqlite')); }
  catch (error) { releaseOwner(); throw error; }
  let closed = false;
  let execution: Execution;
  let catalog: Catalog;
  let git: GitIntegration;
  let artifacts: ArtifactWorkspace;
  const channels: Partial<PiAdapterChannels> = {};
  const ensureOpen = () => { if (closed) throw new RuntimeError('closed', 'Runtime is closed'); };
  const createMasterNode = (taskId: string) => {
    const master = options.master!;
    const model = masterModel();
    const definitionVersion = masterDefinitionVersion();
    if (!model) throw new RuntimeError('models_missing', 'No configured model for a master agent');
    if (!definitionVersion) throw new RuntimeError('definition_missing', 'No configured definition for a master agent');
    const spec: NodeSpec = { id: 'master', kind: 'agent', action: master.action, definitionVersion, model, role: 'master' };
    const instanceId = randomUUID();
    store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, spec.id, canonicalJson(spec), instanceId);
    insertInstance(instanceId, taskId, spec.id, spec.definitionVersion, spec.model);
    createActivation(store, taskId, spec.id, 0);
    return instanceId;
  };
  const modelScheduler: ModelScheduler = options.models?.modelScheduler ? options.models.modelScheduler : createModelScheduler();
  // The current configuration is the source of truth for what can be started;
  // persisted projects stay for history but cannot receive new tasks after
  // they are removed from the config. A hot apply updates this view in the
  // same process, so the wizard does not need a restart.
  const configuredProjects = (): ProjectConfig[] | undefined => options.live?.projects ? options.live.projects() : options.projects;
  const allowedProjects = () => new Set((configuredProjects() ?? []).map(project => project.id));
  // Live getters: hot configuration changes must affect the next use without
  // reopening the runtime; static options remain for unit tests.
  /** The one effective access policy: dispatch and the merge turn must never disagree about it. */
  const resolvedAccessPolicy = () => resolveAccessPolicy(options.access?.() ?? standardAccessPolicy(), {
    home: homedir(),
    stateDir,
    graphHome: options.catalog?.capabilityRoot ? resolve(options.catalog.capabilityRoot, '..') : resolve(homedir(), '.graph'),
  });
  const liveEntries = () => options.live?.entries() ?? options.models?.entries ?? [];
  // §13.8: the v2 kernel shares this database, so its tables must exist as soon as the
  // runtime opens - the host loop queries them every tick, and an older database is
  // migrated here rather than by the first graph that happens to run.
  const kernel = new KernelStore(store);
  /**
   * The merge Agent's own credential binding, taken from the same live configuration the
   * dispatcher uses, so a merge turn never borrows a key from an unrelated model.
   */
  const liveCredentialFor = (entry: ModelEntry) => options.live
    ? options.live.credentialFor(entry)
    : options.models?.credentialFor?.(entry)
    // A static model configuration carries one key for every entry rather than a resolver;
    // the v2 lane needs the same key the old adapter uses, or no node could run.
    ?? (options.models?.apiKey ? { apiKey: options.models.apiKey } : undefined);
  /**
   * Resolve a lane collision with a real merge Agent turn.
   *
   * The turn runs at the recipe's medium grade, under full access and with no budget cap - the
   * user's explicit choice. It is not an operation, so it takes no execution slot and writes no
   * budget row; that gap is recorded in the harness backlog rather than hidden.
   */
  const mergeResolverChannel = () => {
    // Without the prompt library the identity cannot be resolved, and a merge turn that runs
    // without its discipline is worse than a blocked task: it is the one place a model is asked
    // to decide what "both sides" means.
    const library = options.agentContext;
    if (!library) {
      return {
        resolve: async () => {
          throw new RuntimeError('invalid_config', 'The merge Agent needs the Agent context library to resolve its identity');
        },
      };
    }
    const runtime = options.live ? undefined : options.models?.modelRuntime;
    if (!runtime) {
      // A live-config host supplies the runtime per entry; without one the turn cannot be sent.
      return {
        resolve: async () => {
          throw new RuntimeError('model_unavailable', 'The merge Agent needs a model runtime, which this runtime does not have');
        },
      };
    }
    const resolve = createMergeResolver({
      store,
      catalog,
      instancesDir: join(stateDir, 'instances'),
      directory: liveEntries,
      modelRuntime: runtime,
      access: () => resolvedAccessPolicy(),
      apiKeyFor: entry => liveCredentialFor(entry)?.apiKey ?? options.models?.apiKey ?? '',
      library,
    });
    return { resolve };
  };
  const livePreferences = (): Partial<Record<ModelEntry['grade'], string[]>> | undefined =>
    options.live ? options.live.preferences() : options.models?.preferences;
  // `null` is the legitimate unlimited default: it must never fall back to a
  // stale finite startup value when live configuration is present.
  /** The project's workspace for a graph, resolved from its task row. */
const projectRootFor = (store: TaskStore) => (graphId: string) => {
  const row = store.db.prepare('SELECT p.root AS root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(graphId) as { root: string } | undefined;
  return row?.root;
};

const liveBudget = () => options.live ? options.live.defaultBudgetTokens() : options.limits?.defaultBudgetTokens ?? null;
  const masterModel = () => {
    const master = options.master;
    if (!master) return undefined;
    const model = typeof master.model === 'function' ? master.model() : master.model;
    return model?.trim() ? model : undefined;
  };
  const masterDefinitionVersion = () => {
    const master = options.master;
    if (!master) return undefined;
    const version = typeof master.definitionVersion === 'function' ? master.definitionVersion() : master.definitionVersion;
    return version?.trim() ? version : undefined;
  };
  const defaultBudgetTokens = options.limits?.defaultBudgetTokens ?? null;
  // The node row must exist first: instances(task_id,node_id) references nodes.
  const insertInstance = (id: string, taskId: string, nodeId: string, definitionVersion?: string | null, model?: string | null) => {
    const budget = liveBudget();
    store.db.prepare('INSERT INTO instances(id,task_id,node_id,definition_version,model,budget,unlimited) VALUES(?,?,?,?,?,?,?)')
      .run(id, taskId, nodeId, definitionVersion ?? null, model ?? null, budget ?? 0, budget === null ? 1 : 0);
    return id;
  };
  const recoverMasterNodes = (recoverOptions: { reviveParked?: boolean } = {}) => {
    if (!options.master || !masterModel() || !masterDefinitionVersion()) return 0;
    return store.transaction(() => {
      const pending = (store.db.prepare("SELECT id, project_id, phase FROM tasks WHERE phase IN ('discussing','chatting') ORDER BY created_seq").all() as { id: string; project_id: string; phase: string }[])
        // A task whose project was removed from the configuration keeps its
        // history but is not brought back to life. Conversation workspaces
        // are host-owned and stay addressable.
        .filter(task => task.phase === 'chatting' || configuredProjects() === undefined || allowedProjects().has(task.project_id));
      let created = 0;
      for (const task of pending) {
        const nodes = store.db.prepare('SELECT spec FROM nodes WHERE task_id=?').all(task.id) as { spec: string }[];
        if (nodes.some(row => (JSON.parse(row.spec) as NodeSpec).role === 'master')) continue;
        createMasterNode(task.id);
        store.event(task.id, 'task.master_recovered', { reason: 'dispatch was disabled when the task was created' });
        created += 1;
      }
      for (const task of recoverOptions.reviveParked ? pending : []) {
        if (recoverMaster(store, task.id, 'configuration')) created += 1;
      }
      const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
      const firstDiscussing = pending.find(task => task.phase === 'discussing');
      if (!active_task && firstDiscussing) store.db.prepare('UPDATE runtime SET active_task=?').run(firstDiscussing.id);
      return created;
    });
  };
  /** Persist the settled prepare receipt idempotently; shared by the normal
   * path and crash recovery so a retried requestId returns the same receipt. */
  const settlePrepare = (opId: string, requestId: string, payload: { projectId: string }, prep: { state: string; baselineSha?: string | null }, result: Record<string, unknown>) => {
    const encoded = canonicalJson(payload);
    return store.transaction(() => {
      store.db.prepare('UPDATE git_ops SET state=?, result=? WHERE id=?').run('succeeded', canonicalJson(result as Json), opId);
      const duplicate = store.db.prepare('SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?').get('projects', requestId) as { payload: string; receipt: string } | undefined;
      if (duplicate) {
        if (duplicate.payload !== encoded) throw new RuntimeError('idempotency_conflict', 'requestId was already used with different content');
        return JSON.parse(duplicate.receipt) as Record<string, unknown>;
      }
      const receipt = { ...prep, cursor: store.event(null, 'project.prepared', { projectId: payload.projectId, state: prep.state, baselineSha: prep.baselineSha }) };
      store.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run('projects', requestId, encoded, canonicalJson(receipt));
      return receipt as Record<string, unknown>;
    });
  };

  try {
    if (defaultBudgetTokens !== null && (!Number.isSafeInteger(defaultBudgetTokens) || defaultBudgetTokens <= 0)) {
      throw new RuntimeError('invalid_input', 'limits.defaultBudgetTokens must be a positive integer or null');
    }
    store.transaction(() => {
      for (const project of options.live?.projects ? options.live.projects() : options.projects ?? []) {
        if (!project.id.trim() || !project.root.trim() || project.grants?.some(grant => typeof grant !== 'string' || !grant.trim())) throw new RuntimeError('invalid_input', 'Project identity, root and grants must be nonempty strings');
        const root = resolve(project.root);
        const grants = canonicalJson([...new Set(project.grants ?? [])].sort());
        const previous = store.db.prepare('SELECT root,grants FROM projects WHERE id=?').get(project.id) as { root: string; grants: string } | undefined;
        if (previous && (previous.root !== root || (project.grants !== undefined && previous.grants !== grants))) throw new RuntimeError('project_conflict', 'Persisted project root and base grants cannot change during restore');
        store.db.prepare('INSERT OR IGNORE INTO projects VALUES(?,?,?)').run(project.id, root, grants);
      }
    });
    catalog = new Catalog(store, {
      ...(options.catalog?.capabilityRoot ? { capabilityRoot: options.catalog.capabilityRoot } : {}),
      ...(options.catalog?.recipesPath ? { recipesPath: options.catalog.recipesPath } : {}),
      // The configured projects, read on every refresh: their own `.pi`/`.agents` skill
      // folders belong in the library view next to the global and per-Agent ones.
      projects: () => configuredProjects() ?? [],
    });
    await catalog.refresh();
    git = new GitIntegration(store, stateDir);
    artifacts = new ArtifactWorkspace(store, join(stateDir, 'artifact-workspace'));
    const slotScheduler: ModelScheduler = options.models?.modelScheduler ? options.models.modelScheduler : createModelScheduler();
    if (options.models) {
      store.transaction(() => {
        for (const entry of options.models!.entries) store.db.prepare('INSERT OR REPLACE INTO models VALUES(?,?)').run(entry.id, canonicalJson(entry));
      });
    }
    const fallback = options.models || options.live ? createPiAdapter({
      store, instancesDir: join(stateDir, 'instances'), catalog, directory: liveEntries, artifacts,
      apiKey: options.models?.apiKey ?? '', modelRuntime: options.models!.modelRuntime,
      ...(options.models?.credentialFor ? { bindingFor: (entry: ModelEntry) => options.models!.credentialFor!(entry) } : {}),
      ...(options.live ? { bindingFor: (entry: ModelEntry) => options.live!.credentialFor(entry) } : {}),
      scheduler: modelScheduler,
      ...(options.live ? { sediment: () => sedimentSettings(options.live!.config()) } : {}),
      ...(options.network ? { network: options.network } : {}),
      ...(options.capabilitySecrets ? { capabilitySecrets: options.capabilitySecrets } : {}),
      channels: {
        supervisor: taskId => channels.supervisor!(taskId),
        catalog,
        // A thunk: `execution` is built below this point in the same scope.
        peers: taskId => ({ deliver: (from, input) => sendPeerMessage(store, execution, taskId, from, input) }),
        // Thunks, not values: the conversation service is built below this point in the same scope.
        conversations: {
          service: {
            list: (query?: { archived?: boolean }) => conversations.list(query),
            view: (conversationId: string, query?: { limit?: number; after?: number }) => conversations.view(conversationId, query),
            events: (conversationId: string, after?: number, limit?: number) => conversations.events(conversationId, after, limit),
            chat: (conversationId: string, input: { text: string; requestId: string; source?: Json }) => conversations.chat(conversationId, input),
            steer: (conversationId: string, input: { requestId: string }) => conversations.steer(conversationId, input),
            pause: (conversationId: string, requestId: string) => conversations.pause(conversationId, requestId),
            resume: (conversationId: string, requestId: string) => conversations.resume(conversationId, requestId),
          },
        },
        ...(options.agentContext ? { agentContext: options.agentContext } : {}),
        ...(options.catalog?.bootstrapPrompts ? { bootstrapPrompts: options.catalog.bootstrapPrompts } : {}),
        ...(options.catalog?.bootstrapToolPrompt ? { bootstrapToolPrompt: options.catalog.bootstrapToolPrompt } : {}),
        ...(options.systemContext ? { systemContext: options.systemContext } : {}),
        ...(options.rsi ? { rsi: {
          available: options.rsi.available,
          status: () => options.rsi!.status(),
          apply: (input, context) => options.rsi!.apply(input as RsiChangeInput, {
            store,
            taskId: context.taskId,
            ...(context.operationId ? { operationId: context.operationId } : {}),
            ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          }),
        } } : {}),
      },
    }) : undefined;
    if (options.live) {
      store.transaction(() => {
        for (const entry of options.live!.entries()) store.db.prepare('INSERT OR REPLACE INTO models VALUES(?,?)').run(entry.id, canonicalJson(entry));
      });
    }
    execution = new Execution(store, options.actions ?? {}, {
      ...(fallback ? { fallback } : {}),
      catalog,
      git,
      artifacts,
      // §13.8: a confirmed v2 graph runs here. The lane names the v2 graphs with queued work
      // and drains each through the real kernel, a per-node resident host and the node's own
      // recipe-defined session. It exists when models are configured - without a model a
      // node cannot run - or when the caller supplied scripted actions, which stand in for
      // the node's process (see `scriptedTurn`). The scripted path still submits through
      // the real bridge and kernel, so it exercises settlement rather than faking it.
      ...(options.models || options.live || options.actions ? { graphs: () => kernelGraphLane({
        kernel,
        catalog,
        // §9: a v2 node is metered like any other. Without this the ledger from HB-284
        // was never consulted, because nothing told the lane what a turn might cost.
        ...(() => {
          const budget = liveBudget();
          return budget === null ? {} : { tokenBudget: { budget, unlimited: false }, reserveTokens: DEFAULT_V2_RESERVE_TOKENS };
        })(),
        directory: liveEntries,
        credentialFor: liveCredentialFor,
        instancesDir: join(stateDir, 'instances'),
        stateDir,
        git,
        artifacts,
        // The scripted turn needs the same workspace the lane gives a node, so it is named
        // here rather than inlined twice.
        workspaceFor: projectRootFor(store),
        ...(options.actions && !(options.models || options.live) ? {
          scriptedTurn: async (graphId: string, nodeId: string, text: string, turn: number, workspace?: string) => {
            // The test drives the node with its own ActionAdapter: the same one the old
            // executor used, so a migrated test keeps the result it was written to expect.
            // The adapter is keyed by ACTION, not by node id. The old executor looked it up
            // the same way, and a migrated test keeps the result it was written to expect
            // only if the lookup does too: a graph may name a node `n0` while the action it
            // performs is `work`, and a graph-command node has no adapter at all.
            const row = store.db.prepare("SELECT spec,kind FROM kernel_nodes WHERE task_id=? AND node_id=?").get(graphId, nodeId) as { spec: string; kind: string } | undefined;
            const spec = row ? JSON.parse(row.spec) as { task?: string; recipe?: string } : undefined;
            // A command node is not an agent: it runs its command, with no recipe, no
            // session and no model. Treating it as an Agent is what made a lifted check
            // finish while having done nothing it was asked to do (HB-302).
            const command = (spec as { command?: { run: string; args?: string[]; timeoutMs?: number } } | undefined)?.command;
            if (command) {
              const workspace = projectRootFor(store)(graphId);
              const [program, ...args] = [command.run, ...(command.args ?? [])];
              const run = await import('node:child_process');
              const done = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
                run.execFile(program, args, { cwd: workspace, timeout: command.timeoutMs ?? 60_000, encoding: 'utf8' },
                  (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
              });
              const value = done.code === 0
                ? { text: done.stdout || `${nodeId} ok` }
                : { text: `${program} failed (${done.code}): ${done.stderr || done.stdout}` };
              return { outputs: { out: { enable: true, value } }, missing: [] };
            }
            const action = spec?.task ?? nodeId;
            const adapter = options.actions![action] ?? options.actions![nodeId];
            if (!adapter) return { missing: ['out'] };
            // The adapter is written against the OLD executor's Operation, and reads real
            // fields from it - `workspace` to find its own work copy, `input` for what to do.
            // Handing it a thin object made every adapter that reads either field fail
            // silently, which is why so many migrated graphs simply never ran.
            //
            // The old node's own fields live in the confirmed proposal, not in the v2
            // definition (the definition keeps a fixed shape and drops `input`), so that is
            // where they are read from - by node id, which is what the test named.
            const confirmed = store.db.prepare('SELECT p.spec AS spec FROM proposals p JOIN tasks t ON t.accepted_proposal=p.version WHERE t.id=?').get(graphId) as { spec: string } | undefined;
            const legacyNodes = confirmed ? (JSON.parse(confirmed.spec) as Proposal).nodes ?? [] : [];
            const legacy = legacyNodes.find(node => node.id === nodeId);
            const prepared = await adapter.prepare({
              id: `op-${graphId}-${nodeId}-${turn}`,
              nodeId, instanceId: (row ? (store.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { instance_id: string } | undefined)?.instance_id : undefined) ?? nodeId,
              taskId: graphId, activationId: undefined, turn, action, attempt: turn,
              kind: adapter.kind, model: 'scripted', recipe: spec?.recipe ?? 'worker@1',
              ...(workspace ? { workspace } : {}),
              input: (legacy?.input ?? {}) as Json,
              ...(legacy?.context ? { context: legacy.context } : {}),
              dependencySources: {}, messages: [], images: [],
            } as never);
            const result = await prepared();
            const output = (result as { output?: unknown }).output;
            const value = output === null || output === undefined
              ? { text: `${nodeId} done` }
              : (typeof output === 'object' ? output as Record<string, unknown> : { text: String(output) });
            const accepted = result.outcome === 'completed';
            return { outputs: accepted ? { out: { enable: true, value } } : {}, missing: accepted ? [] : ['out'] };
          },
        } : {}),
        onToolCall: (graphId: string, nodeId: string, name: string, args: unknown) => {
          if (name !== 'submit') return { ok: false, text: `the host does not offer a tool named ${name}` };
          const execution = store.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
          if (!execution) return { ok: false, text: 'no execution is running for this node' };
          const bridge = new NodeSubmitBridge(kernel, execution.id);
          const request = args as { outputs: Record<string, { enable?: boolean; value?: unknown }> };
          const receipt = bridge.submit({ outputs: request.outputs ?? {}, submissionId: `v2-${execution.id}` });
          return receipt.accepted
            ? { ok: true, text: JSON.stringify({ accepted: true, deliveries: receipt.deliveries.length }) }
            : { ok: false, text: bridge.refusalMessage(receipt) };
        },
      }).runnable() } : {}),
      scratchRoot: stateDir,
      ...(options.models || options.live ? { models: liveEntries } : {}),
      ...(options.live || options.models?.preferences ? { preferences: options.live ? livePreferences : options.models!.preferences } : {}),
      ...(options.program ? { program: options.program } : {}),
      access: () => resolvedAccessPolicy(),
      ...(options.systemContext ? {
        systemContext: {
          resources: true,
          agentCombinations: true,
          systemSummary: Boolean(options.systemContext.systemSummary),
        },
      } : {}),
      autoWake: Boolean(options.autoWake),
      ...(options.rsi ? { dispatchAllowed: () => !options.rsi!.hasPendingRestart() } : {}),
      // A lane collision is resolved by a real merge Agent turn whenever models are configured.
      // An explicit channel still wins: a test or a host may supply its own resolver.
      ...(options.mergeResolvers
        ? { mergeResolvers: options.mergeResolvers }
        : options.models || options.live
          ? { mergeResolvers: mergeResolverChannel() }
          : {}),
    });
    // Tasks and conversations created while dispatch was disabled carry no
    // master node. Once a master binding exists they get one and become
    // driveable again; queued conversation messages stay pending until then.
    // The same scan runs after a hot configuration apply.
    if (options.master && masterModel()) recoverMasterNodes();
    // Recognize prepare intents interrupted by a crash. The original external
    // effect is verified first: a concluded Graph baseline is restored as the
    // receipt, an unchanged worktree may be replayed, and anything else is
    // surfaced as unresolved instead of committing whatever is on disk now.
    for (const intent of store.db.prepare("SELECT id,spec FROM git_ops WHERE kind='prepare' AND state='intent'").all() as { id: string; spec: string }[]) {
      const fail = (reason: string, state: 'failed' | 'unresolved' = 'unresolved') => {
        store.db.prepare('UPDATE git_ops SET state=?, result=? WHERE id=?').run(state, canonicalJson({ reason }), intent.id);
      };
      try {
        const parsed = JSON.parse(intent.spec) as {
          payload?: { type: string; projectId: string; initialize: boolean; createBaseline: boolean };
          requestId?: string; headBefore?: string | null; fingerprintBefore?: string | null;
        };
        const payload = parsed.payload;
        if (!payload?.projectId || !parsed.requestId) { fail('Unrecognized interrupted prepare intent', 'failed'); continue; }
        if (!store.db.prepare('SELECT id FROM projects WHERE id=?').get(payload.projectId)) { fail('Project no longer exists', 'failed'); continue; }
        const headBefore = parsed.headBefore ?? null;
        const nowHead = git.projectHead(payload.projectId);
        const last = git.lastCommit(payload.projectId);
        const concludedByGraph = last?.subject === 'graph: local baseline'
          && nowHead !== headBefore
          && (headBefore === null ? last.parents.length === 0 : last.parents[0] === headBefore);
        if (concludedByGraph) {
          // The baseline commit already happened before the crash. Never run
          // Git again: later user edits must not become part of that receipt.
          const prep = git.prepareProject(payload.projectId, {});
          settlePrepare(intent.id, parsed.requestId, payload, prep, { reconciled: true, alreadyApplied: true });
          continue;
        }
        if (nowHead !== headBefore) {
          const reason = 'Interrupted prepare cannot be attributed: HEAD moved without a matching Graph baseline';
          git.markPrepareUnresolved(payload.projectId, reason);
          fail(reason);
          continue;
        }
        const current = git.projectFingerprint(payload.projectId);
        if (current !== (parsed.fingerprintBefore ?? null)) {
          const reason = 'Interrupted prepare left the worktree changed; run prepare again to authorize the new content';
          git.markPrepareUnresolved(payload.projectId, reason);
          fail(reason);
          continue;
        }
        const prep = git.prepareProject(payload.projectId, { initialize: payload.initialize, createBaseline: payload.createBaseline });
        settlePrepare(intent.id, parsed.requestId, payload, prep, { reconciled: true });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    try { store.close(); } finally { releaseOwner(); }
    throw error;
  }
  let closing: Promise<void> | undefined;

  const user = {
    async begin(input: { projectId: string; request: string; requestId: string }): Promise<Receipt> {
      ensureOpen();
      return store.command('user', input.requestId, { type: 'begin', projectId: input.projectId, request: input.request }, () => {
        if (!input.request.trim() || !store.db.prepare('SELECT id FROM projects WHERE id=?').get(input.projectId)) throw new RuntimeError('invalid_input', 'A known project and nonempty request are required');
        if (configuredProjects() !== undefined && !allowedProjects().has(input.projectId)) throw new RuntimeError('invalid_input', 'The project is no longer part of the current configuration');
        const taskId = randomUUID();
        const sequence = (store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count + 1;
        store.db.prepare('INSERT INTO tasks(id,project_id,request,created_seq) VALUES(?,?,?,?)').run(taskId, input.projectId, input.request, sequence);
        if (options.master && masterModel() && masterDefinitionVersion()) {
          const spec: NodeSpec = { id: 'master', kind: 'agent', action: options.master.action, definitionVersion: masterDefinitionVersion()!, model: masterModel()!, role: 'master' };
          const instanceId = randomUUID();
          store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, spec.id, canonicalJson(spec), instanceId);
          insertInstance(instanceId, taskId, spec.id, spec.definitionVersion, spec.model);
          createActivation(store, taskId, spec.id, 0);
          const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
          if (!active_task) store.db.prepare('UPDATE runtime SET active_task=?').run(taskId);
        }
        return { taskId, cursor: store.event(taskId, 'task.created', { request: input.request, configRevision: options.live?.revision() ?? options.config?.revision() ?? null }) };
      });
    },
    task(taskId: string) {
      ensureOpen(); store.task(taskId);
      const setPaused = (paused: boolean, requestId: string): { receipt: Receipt; stoppedMaster: boolean } => {
        ensureOpen();
        let stoppedMaster = false;
        const receipt = store.command('user', requestId, { type: paused ? 'pause' : 'resume', taskId }, () => {
          store.db.prepare('UPDATE tasks SET paused=? WHERE id=?').run(Number(paused), taskId);
          // Pause/resume are explicit state boundaries: accumulate the ledger
          // here instead of inferring durations from event or message times.
          if (paused) {
            openPause(store, taskId);
            // Remember the live master turn so a later resume continues it
            // instead of waiting for a new user message.
            const active = store.db.prepare(`SELECT o.id FROM operations o
              JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
              WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
                AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid DESC LIMIT 1`).get(taskId) as { id: string } | undefined;
            if (active) stoppedMaster = awaitPauseContinuation(store, requestId, taskId, active.id);
          } else {
            closePause(store, taskId);
            resumePauseContinuations(store, taskId);
          }
          return { taskId, cursor: store.event(taskId, paused ? 'task.pause_requested' : 'task.resumed', {}) };
        });
        return { receipt, stoppedMaster };
      };
      return {
        async pause(requestId: string) {
          const { receipt, stoppedMaster } = setPaused(true, requestId);
          // Soft-stop the running master turn after the in-flight tool call;
          // the flag and the durable wake-up are already committed above.
          if (stoppedMaster) await execution.stopActiveMasterTurns(taskId);
          return receipt;
        },
        async resume(requestId: string) {
          const { receipt } = setPaused(false, requestId);
          if (options.autoWake) execution.kick();
          return receipt;
        },
        /** Stop the task for good, releasing the active slot to the queue. */
        async abandon(requestId: string, reason?: string): Promise<Receipt> {
          ensureOpen();
          const receipt = store.command('user', requestId, { type: 'abandon', taskId, reason: reason ?? null }, () => ({
            taskId, cursor: execution.abandon(taskId, reason ?? null),
          }));
          if (options.autoWake) execution.kick();
          return receipt;
        },
        /** User-owned budget policy change: a finite cap or explicit unlimited.
         * Instance identity, used total and every other gate stay untouched. */
        async setBudget(input: { nodeId: string; tokens: number | null; requestId: string }): Promise<Receipt> {
          ensureOpen();
          if (typeof input.nodeId !== 'string' || !input.nodeId.trim()) throw new RuntimeError('invalid_input', 'A nodeId is required');
          if (input.tokens !== null && (!Number.isSafeInteger(input.tokens) || input.tokens <= 0)) throw new RuntimeError('invalid_input', 'Budget must be a positive integer or null');
          const receipt = store.command('user', input.requestId, { type: 'set_budget', taskId, nodeId: input.nodeId, tokens: input.tokens }, () => {
            const instance = store.db.prepare('SELECT id FROM instances WHERE task_id=? AND node_id=?').get(taskId, input.nodeId) as { id: string } | undefined;
            if (!instance) throw new RuntimeError('not_found', 'Unknown agent node');
            setBudget(store, instance.id, input.tokens);
            // An explicit policy change resolves the budget question that
            // blocked this node. Permission and unknown-usage questions stay.
            const resolved = store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'")
              .run(canonicalJson({ type: 'set_budget', tokens: input.tokens }), taskId, input.nodeId);
            if (resolved.changes) {
              closeUserWait(store, taskId, input.nodeId);
              const stillOpen = store.db.prepare("SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'").get(taskId, input.nodeId);
              if (!stillOpen) store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(taskId, input.nodeId);
            }
            return { taskId, cursor: store.event(taskId, 'instance.budget_changed', { nodeId: input.nodeId, tokens: input.tokens }) };
          });
          execution.finish(taskId);
          return receipt;
        },
        async answer(questionId: string, answer: Answer, requestId: string): Promise<Receipt> {
          ensureOpen();
          const receipt = store.command('user', requestId, { type: 'answer', taskId, questionId, answer }, () => {
            execution.answer(taskId, questionId, answer);
            return { taskId, cursor: store.event(taskId, 'question.answered', { questionId, answer }) };
          });
          execution.finish(taskId);
          return receipt;
        },
        async say(text: string, requestId: string): Promise<Receipt> {
          ensureOpen();
          return store.command('user', requestId, { type: 'say', taskId, text }, () => {
            const task = store.task(taskId);
            if (!text.trim()) throw new RuntimeError('invalid_input', 'A nonempty message is required');
            if (task.accepted_proposal !== null) throw new RuntimeError('requirements_locked', 'Confirmed requirements need an explicit impact review');
            store.db.prepare('UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?').run(taskId);
            if (task.accepted_proposal === null) {
              const rows = store.db.prepare('SELECT id,status,spec FROM nodes WHERE task_id=?').all(taskId) as { id: string; status: string; spec: string }[];
              for (const row of rows) {
                if ((JSON.parse(row.spec) as NodeSpec).role !== 'master') continue;
                if (['preparing', 'running'].includes(row.status) || hasLockedQuestion(store, taskId, row.id)) continue;
                store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(taskId, row.id);
              }
            }
            return { taskId, cursor: store.event(taskId, 'requirement.changed', { text, requirementVersion: task.requirement_version + 1 }) };
          });
        },
        async accept(input: { proposalVersion: number; targetBranch: string; requestId: string }): Promise<Receipt> {
          ensureOpen();
          // Formal acceptance requires a ready Git project and an existing
          // target branch; this fails before any official state is written.
          git.requireTargetBranch(store.task(taskId).project_id, input.targetBranch);
          const receipt = store.command('user', input.requestId, { type: 'accept', taskId, proposalVersion: input.proposalVersion, targetBranch: input.targetBranch }, () => {
            const task = store.task(taskId);
            const row = store.db.prepare('SELECT requirement_version,spec FROM proposals WHERE task_id=? AND version=?')
              .get(taskId, input.proposalVersion) as { requirement_version: number; spec: string } | undefined;
            if (!row || task.latest_proposal !== input.proposalVersion || row.requirement_version !== task.requirement_version) throw new RuntimeError('stale_proposal', 'Only the current requirement proposal can be accepted');
            if (task.accepted_proposal !== null) throw new RuntimeError('already_accepted', 'Task already has confirmed requirements');
            if (!input.targetBranch.trim()) throw new RuntimeError('invalid_input', 'A target branch is required');
            const proposal = JSON.parse(row.spec) as Proposal;
            // §13.8 switchover: a draft carrying a v2 graph definition creates a v2 graph.
            // Only the conversation confirm path did this, so a task confirmed through this
            // entry point - which is what the HTTP API uses - wrote old declarative rows even
            // for a v2 draft, and the graph never reached the kernel.
            if (proposal.definition) {
              materializeGraph(new KernelStore(store), taskId, parseGraphDefinition(proposal.definition), 'Confirmed task graph');
            } else {
            store.db.prepare('INSERT INTO graph_revisions(task_id,version,spec,reason,base_version) VALUES(?,?,?,?,?)').run(taskId, 1, row.spec, 'Confirmed task graph', 0);
            for (const node of proposal.nodes) {
              const existing = store.db.prepare('SELECT instance_id FROM nodes WHERE task_id=? AND id=?').get(taskId, node.id) as { instance_id: string | null } | undefined;
              if (existing) {
                store.db.prepare('UPDATE nodes SET spec=?,status=? WHERE task_id=? AND id=?').run(canonicalJson(node), node.kind === 'agent' ? 'pending' : 'pending', taskId, node.id);
                continue;
              }
              const instanceId = node.kind === 'agent' ? randomUUID() : null;
              store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, node.id, canonicalJson(node), instanceId);
              if (instanceId) insertInstance(instanceId, taskId, node.id, node.definitionVersion ?? null, node.model ?? null);
              createActivation(store, taskId, node.id, 1);
            }
            }
            const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
            const phase = !active_task || active_task === taskId ? 'running' : 'queued';
            store.db.prepare('UPDATE tasks SET accepted_proposal=?,target_branch=?,phase=?,graph_version=1 WHERE id=?')
              .run(input.proposalVersion, input.targetBranch, phase, taskId);
            if (!active_task || active_task === taskId) store.db.prepare('UPDATE runtime SET active_task=?').run(taskId);
            return { taskId, cursor: store.event(taskId, 'task.accepted', { proposalVersion: input.proposalVersion, targetBranch: input.targetBranch }) };
          });
          git.prepareTask(taskId, input.targetBranch);
          return receipt;
        },
        async view() {
          ensureOpen();
          const task = store.task(taskId);
          const rows = store.db.prepare('SELECT n.id,n.spec,n.instance_id,n.status,n.activation_id,n.output_version,n.stall_count,i.used,i.budget,i.unlimited,i.model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid').all(taskId) as { id: string; spec: string; instance_id: string | null; status: string; used: number | null; budget: number | null; unlimited: number | null; activation_id: string; output_version: number; stall_count: number; model: string | null; definition_version: string | null }[];
          const invocations = invocationRows(store, taskId);
          const unknownCost = invocations.some(item => item.cost && typeof item.cost === 'object' && !Array.isArray(item.cost) && item.cost.unknown === true);
          const cost = unknownCost ? { unknown: true as const } : { amount: invocations.reduce((sum, item) => {
            const value = item.cost && typeof item.cost === 'object' && !Array.isArray(item.cost) && typeof item.cost.amount === 'number' ? item.cost.amount : 0;
            return sum + value;
          }, 0) };
          const evidence = store.db.prepare('SELECT node_id,operation_id,proposal_version,requirement_version,data,activation_id,valid,commit_sha FROM evidence WHERE task_id=? ORDER BY rowid').all(taskId) as { node_id: string; operation_id: string; proposal_version: number; requirement_version: number; data: string; activation_id: string; valid: number; commit_sha: string | null }[];
          const operations = operationSnapshots(store, taskId, { latest: true, limit: 50 });
          const operationTotals = store.db.prepare(`SELECT node_id,COUNT(*) AS total,SUM(reserved) AS reserved,MAX(worker_active) AS active
            FROM operations WHERE task_id=? GROUP BY node_id`).all(taskId) as { node_id: string; total: number; reserved: number; active: number }[];
          const operationCount = operationTotals.reduce((sum, row) => sum + row.total, 0);
          const questions = store.db.prepare('SELECT * FROM questions WHERE task_id=? ORDER BY rowid').all(taskId) as { id: string; node_id: string; operation_id: string | null; kind: string; status: string; data: string; answer: string | null; owner: string }[];
          const userQuestions = questions.filter(question => question.owner === 'user');
          const proposal = store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(taskId, task.latest_proposal) as { spec: string } | undefined;
          // A queued task is invisible work: name the task holding the single
          // active slot and how many problems it is stuck on, so a wedged queue
          // is diagnosable from the task view instead of from the database.
          const activeTask = store.db.prepare('SELECT id, project_id FROM tasks WHERE id=(SELECT active_task FROM runtime)').get() as { id: string; project_id: string } | undefined;
          const queuedBehind = task.phase === 'queued' && activeTask
            ? { taskId: activeTask.id, projectId: activeTask.project_id, openProblems: (store.db.prepare("SELECT COUNT(*) AS count FROM questions WHERE task_id=? AND owner='main' AND status='open'").get(activeTask.id) as { count: number }).count }
            : null;
          const messages = (store.db.prepare("SELECT cursor,type,data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor").all(taskId) as { cursor: number; type: string; data: string }[]).map(row => {
            const message = JSON.parse(row.data) as { text?: string; request?: string; requirementVersion?: number };
            return { cursor: row.cursor, text: message.text ?? message.request!, requirementVersion: message.requirementVersion ?? 1 };
          });
          return {
            id: task.id, conversationId: task.conversation_id, projectId: task.project_id, request: task.request, requirementVersion: task.requirement_version,
            proposalVersion: task.latest_proposal, acceptedProposalVersion: task.accepted_proposal,
            graphVersion: task.graph_version,
            proposal: proposal ? JSON.parse(proposal.spec) as Proposal : null, messages,
            ...(() => {
              // A task accepted on the v2 kernel has an accepted proposal but no old-shaped
              // rows at all, so loadGraph would throw on it. It genuinely has no containers
              // and no loops - those are old-kernel concepts - so report them empty rather
              // than failing the whole view.
              let graph: ReturnType<typeof loadGraph> | undefined;
              if (task.accepted_proposal) {
                try { graph = loadGraph(store, taskId); } catch { graph = undefined; }
              }
              return { containers: graph ? graph.containers() : [], loops: graph ? graph.plan.loops : [] };
            })(),
            revisions: (store.db.prepare('SELECT version,reason,base_version FROM graph_revisions WHERE task_id=? ORDER BY version').all(taskId) as { version: number; reason: string; base_version: number }[]),
            targetBranch: task.target_branch, phase: task.phase, paused: Boolean(task.paused), queuedBehind,
            updatedAt: (store.db.prepare('SELECT MAX(timestamp) AS updatedAt FROM events WHERE task_id=?').get(taskId) as { updatedAt: number | null }).updatedAt,
            status: task.paused ? (operationTotals.some(row => row.active) ? 'pausing' : 'paused') : userQuestions.some(q => q.status === 'open') ? 'blocked' : task.phase,
            operationHistory: { total: operationCount, limit: 50, hasOlder: operationCount > operations.length, oldestId: operations[0]?.id ?? null },
            operations: operations.map(row => ({ ...row.operation, state: row.state, reserved: row.reserved, workerActive: row.workerActive, result: row.result })),
            questions: questions.map(row => ({ id: row.id, nodeId: row.node_id, operationId: row.operation_id, kind: row.kind, status: row.status, owner: row.owner, data: JSON.parse(row.data) as Json, answer: row.answer ? JSON.parse(row.answer) as Json : null })),
            internalProblemCount: questions.filter(row => row.owner === 'main' && row.status === 'open').length,
            worktrees: (store.db.prepare('SELECT instance_id,node_id,path,branch FROM worktrees WHERE task_id=?').all(taskId) as { instance_id: string; node_id: string; path: string; branch: string }[])
              .map(row => ({ instanceId: row.instance_id, nodeId: row.node_id, path: row.path, branch: row.branch })),
            integrationSha: task.integration_sha,
            // A v2 graph's nodes live in `kernel_nodes`, not `nodes`. They are merged in so
            // a user opening a v2 task sees the graph at all, and so a node parked on an
            // exhausted budget reads as `blocked` instead of vanishing. They carry the same
            // keys the legacy rows do - empty where a v2 node has no such thing - because a
            // missing key breaks every consumer that reads it.
            nodes: [
              ...rows.map(row => ({ ...JSON.parse(row.spec) as NodeSpec, instanceId: row.instance_id, activationId: row.activation_id, outputVersion: row.output_version, stallCount: row.stall_count, status: row.status, used: row.used, unlimited: Boolean(row.unlimited), budget: row.unlimited ? null : row.budget,
              ...(row.model ? { selectedModel: row.model } : {}), ...(row.definition_version ? { boundDefinition: row.definition_version } : {}),
              reserved: operationTotals.find(total => total.node_id === row.id)?.reserved ?? 0 })),
              ...new KernelStore(store).listNodes(taskId).map(node => ({
                ...({} as NodeSpec),
                id: node.nodeId, kind: (node.kind === 'module' ? 'program' : 'agent') as NodeSpec['kind'],
                action: node.nodeId, definitionVersion: '', model: '',
                instanceId: node.instanceId, activationId: '', outputVersion: 0, stallCount: 0,
                used: 0, unlimited: false, budget: null, reserved: 0,
                optional: false, boundDefinition: '', selectedModel: '',
                status: node.status, origin: 'v2' as const, revisionVersion: node.revisionVersion,
              })),
            ],
            evidence: evidence.map(row => ({ ...JSON.parse(row.data) as EvidenceInput, nodeId: row.node_id, operationId: row.operation_id, proposalVersion: row.proposal_version, requirementVersion: row.requirement_version, activationId: row.activation_id, valid: Boolean(row.valid), ...(row.commit_sha ? { commitSha: row.commit_sha } : {}) })),
            invocations, cost,
            cursor: (store.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events').get() as { cursor: number }).cursor,
          };
        },
        watch(after = 0): TaskWatch {
          ensureOpen();
          if (!Number.isSafeInteger(after) || after < 0) throw new RuntimeError('invalid_cursor', 'Invalid event cursor');
          const controller = new AbortController();
          const iterator = (async function* () {
            let cursor = after;
            while (!closed && !controller.signal.aborted) {
              const wake = store.waitForChange(controller.signal);
              const rows = store.db.prepare('SELECT cursor,type,data,timestamp FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT 100')
                .all(taskId, cursor) as { cursor: number; type: string; data: string; timestamp: number }[];
              if (rows.length) {
                wake.cancel();
                for (const row of rows) {
                  if (controller.signal.aborted) return;
                  cursor = row.cursor;
                  yield { ...row, taskId, data: JSON.parse(row.data) } as TaskUpdate;
                }
              } else {
                // The wake normally fires immediately; the bounded fallback
                // heals any writer that could not notify and keeps the
                // stream caught up with the database.
                await Promise.race([wake.promise, new Promise(resolve => setTimeout(resolve, 250))]);
                wake.cancel();
              }
            }
          })();
          return {
            [Symbol.asyncIterator]() { return this; },
            next: () => iterator.next(),
            return: async () => { controller.abort(); return iterator.return(); },
          };
        },
      };
    },
    async list() {
      ensureOpen();
      const rows = store.db.prepare(`SELECT t.id,t.project_id AS projectId,t.request,t.phase,t.paused,t.accepted_proposal AS acceptedProposalVersion,
        t.conversation_id AS conversationId,
        (SELECT MIN(timestamp) FROM events WHERE task_id=t.id) AS createdAt,
        (SELECT MAX(timestamp) FROM events WHERE task_id=t.id) AS updatedAt,
        (SELECT COUNT(*) FROM questions WHERE task_id=t.id AND status='open' AND owner='user') AS openQuestions
        FROM tasks t WHERE t.phase!='chatting' ORDER BY t.created_seq`).all() as { id: string; projectId: string; request: string; phase: string; paused: number; acceptedProposalVersion: number | null; conversationId: string | null; createdAt: number; updatedAt: number | null; openQuestions: number }[];
      return rows.map(row => ({
        id: row.id, projectId: row.projectId, request: row.request, phase: row.phase, conversationId: row.conversationId,
        status: row.paused ? 'paused' : row.openQuestions > 0 ? 'blocked' : row.phase,
        acceptedProposalVersion: row.acceptedProposalVersion, createdAt: row.createdAt, updatedAt: row.updatedAt, openQuestions: row.openQuestions,
      }));
    },
    async projects() {
      ensureOpen();
      const withPreparation = <T extends { id: string }>(project: T) => ({ ...project, preparation: git.preparation(project.id) });
      const configured = configuredProjects();
      if (configured !== undefined) {
        return configured.map(project => withPreparation({ id: project.id, root: resolve(project.root), grants: [...new Set(project.grants ?? [])].sort() }));
      }
      return (store.db.prepare('SELECT id,root,grants FROM projects ORDER BY id').all() as { id: string; root: string; grants: string }[])
        .map(row => withPreparation({ id: row.id, root: row.root, grants: JSON.parse(row.grants) as string[] }));
    },
  };

  const taskCost = (id: string) => sumCosts(invocationRows(store, id).map(item => item.cost));

  /** The anchor plus every feature task created from this conversation. */
  const conversationTaskIds = (store: TaskStore, conversationId: string) => {
    const anchor = conversationRow(store, conversationId).anchor_task_id;
    const linked = (store.db.prepare('SELECT id FROM tasks WHERE conversation_id=?').all(conversationId) as { id: string }[]).map(row => row.id);
    return [...new Set([anchor, ...linked])];
  };

  // Conversation entry: chat messages are durable and queue behind the master
  // turn, while every formal change (bind, confirm) is a validated command.
  const conversations = {
    async create(input: { projectId?: string; title?: string; text?: string; attachments?: AttachmentInput[]; model?: string; thinkingLevel?: string; requestId: string }) {
      ensureOpen();
      const conversationId = randomUUID();
      if (!input.projectId) await mkdir(join(stateDir, 'conversations', conversationId), { recursive: true, mode: 0o700 });
      const attachments = cleanAttachments(input.attachments);
      return store.command('conversations', input.requestId, {
        type: 'create',
        projectId: input.projectId ?? null,
        title: input.title ?? null,
        text: input.text ?? null,
        attachments,
        model: input.model ?? null,
        thinkingLevel: input.thinkingLevel ?? null,
      }, () => {
        if (!input.text?.trim() && !attachments.length) throw new RuntimeError('invalid_input', 'A nonempty first message or attachment is required');
        const projectId = input.projectId ?? null;
        let workspaceProjectId: string;
        if (projectId !== null) {
          if (!store.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) throw new RuntimeError('invalid_input', 'A known project is required');
          if (configuredProjects() !== undefined && !allowedProjects().has(projectId)) throw new RuntimeError('invalid_input', 'The project is no longer part of the current configuration');
          workspaceProjectId = projectId;
        } else {
          // The host-owned scratch workspace keeps an unbound conversation on
          // the ordinary project/grant path without granting any real root.
          const root = join(stateDir, 'conversations', conversationId);
          store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run(`conversation:${conversationId}`, root, '[]');
          workspaceProjectId = `conversation:${conversationId}`;
        }
        const taskId = randomUUID();
        const sequence = (store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count + 1;
        const title = (input.title?.trim() || input.text?.trim() || '新对话').slice(0, 120);
        store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,phase,created_seq,conversation_id) VALUES(?,?,?,1,?,?,?)').run(taskId, workspaceProjectId, title, 'chatting', sequence, conversationId);
        store.db.prepare('INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES(?,?,?,?,?,?,?)').run(conversationId, projectId, workspaceProjectId, taskId, title, sequence, Date.now());
        if (options.master && masterModel()) {
          createMasterNode(taskId);
          const requestedModel = input.model?.trim();
          const selected = requestedModel ? liveEntries().find(model => model.id === requestedModel) : undefined;
          if (requestedModel && !selected) throw new RuntimeError('model_unavailable', 'The selected model is not configured');
          if (selected) {
            const master = store.db.prepare("SELECT spec,instance_id FROM nodes WHERE task_id=? AND id='master'").get(taskId) as { spec: string; instance_id: string };
            const spec = JSON.parse(master.spec) as NodeSpec;
            spec.model = selected.id;
            store.db.prepare("UPDATE nodes SET spec=? WHERE task_id=? AND id='master'").run(canonicalJson(spec), taskId);
            store.db.prepare('UPDATE instances SET model=? WHERE id=?').run(selected.id, master.instance_id);
          }
          const effective = selected ?? liveEntries().find(model => model.id === masterModel());
          const requestedLevel = input.thinkingLevel ? asThinkingLevel(input.thinkingLevel) : undefined;
          // Thinking is always on: a requested level this model does not accept
          // (and `off`, which is no longer offered) resolves to one it does, so
          // the stored level always matches what the next turn will run.
          const level = effective ? effectiveThinkingLevel(effective, requestedLevel) : undefined;
          if (level) store.db.prepare('UPDATE conversations SET thinking_level=? WHERE id=?').run(level, conversationId);
        }
        let cursor = store.event(taskId, 'conversation.created', { conversationId, projectId, title });
        let messageId: string | null = null;
        if (input.text?.trim() || attachments.length) {
          const message = appendMessage(store, {
            conversationId, role: 'user', kind: 'chat', text: input.text?.trim() ?? '', state: 'pending',
            ...(attachments.length ? { data: { attachments } as unknown as Json } : {}),
          });
          messageId = message.id;
          if (options.master) store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id='master'").run(taskId);
          if (typeof message.cursor === 'number') cursor = message.cursor;
        }
        return { conversationId, taskId, title, messageId, cursor };
      });
    },
    async list(input: { archived?: boolean } = {}) {
      ensureOpen();
      const archived = Boolean(input.archived);
      const rows = store.db.prepare(`SELECT c.id,c.title,c.project_id AS projectId,c.anchor_task_id AS anchorTaskId,c.created_at AS createdAt,
        c.archived_at AS archivedAt,
        (SELECT MAX(e.timestamp) FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.conversation_id=c.id) AS updatedAt,
        (SELECT COUNT(*) FROM questions q JOIN tasks t ON t.id=q.task_id WHERE t.conversation_id=c.id AND q.status='open' AND q.owner='user') AS openQuestions,
        (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id=c.id AND t.phase!='chatting') AS taskCount
        FROM conversations c WHERE c.archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
        ORDER BY c.created_seq`).all() as { id: string; title: string; projectId: string | null; anchorTaskId: string; createdAt: number; archivedAt: number | null; updatedAt: number | null; openQuestions: number; taskCount: number }[];
      return rows.map(row => ({
        id: row.id, title: row.title, projectId: row.projectId, anchorTaskId: row.anchorTaskId, createdAt: row.createdAt,
        archivedAt: row.archivedAt, updatedAt: row.updatedAt, openQuestions: row.openQuestions, taskCount: row.taskCount,
        status: row.openQuestions > 0 ? 'blocked' : row.taskCount > 0 ? 'executing' : 'chatting',
      }));
    },
    archive(conversationId: string, requestId: string) {
      ensureOpen();
      const conversation = conversationRow(store, conversationId);
      return store.command(`conversation:${conversationId}`, requestId, { type: 'archive' }, () => {
        const now = Date.now();
        if (conversation.archived_at === null) store.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(now, conversationId);
        return {
          conversationId,
          archived: true,
          archivedAt: conversation.archived_at ?? now,
          cursor: store.event(conversation.anchor_task_id, 'conversation.archived', { conversationId }),
        };
      });
    },
    unarchive(conversationId: string, requestId: string) {
      ensureOpen();
      const conversation = conversationRow(store, conversationId);
      return store.command(`conversation:${conversationId}`, requestId, { type: 'unarchive' }, () => {
        if (conversation.archived_at !== null) store.db.prepare('UPDATE conversations SET archived_at=NULL WHERE id=?').run(conversationId);
        return {
          conversationId,
          archived: false,
          archivedAt: null,
          cursor: store.event(conversation.anchor_task_id, 'conversation.unarchived', { conversationId }),
        };
      });
    },
    selectModel(conversationId: string, input: { model: string; thinkingLevel: ThinkingLevel; requestId: string }) {
      ensureOpen();
      conversationRow(store, conversationId);
      if (!input.model.trim()) throw new RuntimeError('invalid_input', 'A model is required');
      const requestedThinking = asThinkingLevel(input.thinkingLevel);
      return store.command(`conversation:${conversationId}`, input.requestId, {
        type: 'select_model', model: input.model.trim(), thinkingLevel: requestedThinking,
      }, () => {
        const entry = liveEntries().find(model => model.id === input.model.trim());
        if (!entry) throw new RuntimeError('model_unavailable', 'The selected model is not configured');
        const thinkingLevel = effectiveThinkingLevel(entry, requestedThinking);
        const master = store.db.prepare(`
          SELECT n.instance_id,n.spec
          FROM nodes n
          WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'
        `).get(conversationRow(store, conversationId).anchor_task_id) as { instance_id: string; spec: string } | undefined;
        if (!master?.instance_id) throw new RuntimeError('model_unavailable', 'This conversation has no master Agent instance');
        const spec = JSON.parse(master.spec) as NodeSpec;
        const changed = spec.model !== entry.id || conversationRow(store, conversationId).thinking_level !== thinkingLevel;
        spec.model = entry.id;
        store.db.prepare('UPDATE nodes SET spec=? WHERE task_id=? AND id=?')
          .run(canonicalJson(spec), conversationRow(store, conversationId).anchor_task_id, spec.id);
        store.db.prepare('UPDATE instances SET model=? WHERE id=?').run(entry.id, master.instance_id);
        store.db.prepare('UPDATE conversations SET thinking_level=? WHERE id=?').run(thinkingLevel, conversationId);
        if (changed) store.event(conversationRow(store, conversationId).anchor_task_id, 'conversation.model_selected', {
          model: entry.id, thinkingLevel,
        });
        return { conversationId, model: entry.id, thinkingLevel, changed };
      });
    },
    async view(conversationId: string, query: { after?: number; before?: number; limit?: number } = {}) {
      ensureOpen();
      const conversation = conversationRow(store, conversationId);
      const anchor = store.task(conversation.anchor_task_id);
      const master = store.db.prepare("SELECT n.status,i.used,i.budget,i.unlimited,COALESCE(i.model,json_extract(n.spec,'$.model')) AS model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'").get(conversation.anchor_task_id) as { status: string; used: number | null; budget: number | null; unlimited: number | null; model: string | null; definition_version: string | null } | undefined;
      const accepted = store.db.prepare('SELECT proposal_version,task_id,target_branch,accepted_at FROM conversation_acceptances WHERE conversation_id=? ORDER BY accepted_at').all(conversationId) as { proposal_version: number; task_id: string; target_branch: string; accepted_at: number }[];
      const acceptedVersions = new Set(accepted.map(row => row.proposal_version));
      const proposalRows = store.db.prepare('SELECT version,requirement_version,spec,decision_snapshot FROM proposals WHERE task_id=? ORDER BY version').all(anchor.id) as unknown as ProposalRow[];
      const proposal = anchor.latest_proposal
        ? conversationProposal(store, anchor.id, anchor.latest_proposal, anchor.requirement_version)
        : null;
      const proposalHistory = proposalRows.map(row => {
        const spec = JSON.parse(row.spec) as Proposal;
        return {
          version: row.version,
          requirementVersion: row.requirement_version,
          stale: row.requirement_version !== anchor.requirement_version,
          summary: spec.summary,
          accepted: acceptedVersions.has(row.version),
        };
      });
      const tasks = (store.db.prepare("SELECT id,request,phase,paused,target_branch,accepted_proposal,integration_sha,(SELECT MIN(timestamp) FROM events WHERE task_id=tasks.id) AS createdAt FROM tasks WHERE conversation_id=? AND phase!='chatting' ORDER BY created_seq").all(conversationId) as { id: string; request: string; phase: string; paused: number; target_branch: string | null; accepted_proposal: number | null; integration_sha: string | null; createdAt: number }[]).map(task => {
        const nodes = store.db.prepare('SELECT n.id,n.spec,n.status,n.stall_count,n.output_version,i.used,i.budget,i.unlimited,i.model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid').all(task.id) as { id: string; spec: string; status: string; stall_count: number; output_version: number; used: number | null; budget: number | null; unlimited: number | null; model: string | null; definition_version: string | null }[];
        const questions = store.db.prepare('SELECT id,node_id,kind,status,data,owner FROM questions WHERE task_id=? ORDER BY rowid').all(task.id) as { id: string; node_id: string; kind: string; status: string; data: string; owner: string }[];
        const open = questions.filter(question => question.status === 'open');
        const openForUser = open.filter(question => question.owner === 'user');
        const evidence = store.db.prepare('SELECT acceptance_id,valid FROM evidence WHERE task_id=? ORDER BY rowid').all(task.id) as { acceptance_id: string; valid: number }[];
        return {
          id: task.id, request: task.request, phase: task.phase, paused: Boolean(task.paused), createdAt: task.createdAt,
          status: task.paused ? 'paused' : openForUser.length ? 'blocked' : task.phase,
          targetBranch: task.target_branch, acceptedProposalVersion: task.accepted_proposal, integrationSha: task.integration_sha,
          openQuestions: openForUser.map(question => ({ id: question.id, nodeId: question.node_id, kind: question.kind, data: JSON.parse(question.data) as Json })),
          internalProblemCount: open.filter(question => question.owner === 'main').length,
          nodes: nodes.map(row => ({ id: row.id, kind: (JSON.parse(row.spec) as NodeSpec).kind, role: (JSON.parse(row.spec) as NodeSpec).role ?? null, status: row.status, used: row.used, unlimited: Boolean(row.unlimited), budget: row.unlimited ? null : row.budget, model: row.model, definitionVersion: row.definition_version, stallCount: row.stall_count, outputVersion: row.output_version })),
          cost: taskCost(task.id),
          evidence: evidence.map(item => ({ acceptanceId: item.acceptance_id, valid: Boolean(item.valid) })),
        };
      });
      const project = conversation.project_id ? store.db.prepare('SELECT root FROM projects WHERE id=?').get(conversation.project_id) as { root: string } | undefined : undefined;
      const anchorQuestions = (store.db.prepare('SELECT id,node_id,operation_id,kind,status,data,answer,owner FROM questions WHERE task_id=? ORDER BY rowid').all(conversation.anchor_task_id) as { id: string; node_id: string; operation_id: string | null; kind: string; status: string; data: string; answer: string | null; owner: string }[])
        .map(question => ({ id: question.id, nodeId: question.node_id, operationId: question.operation_id, kind: question.kind, status: question.status, owner: question.owner, data: JSON.parse(question.data) as Json, answer: question.answer ? JSON.parse(question.answer) as Json : null, taskId: conversation.anchor_task_id }));
      const ledgerCost = taskCost(conversation.anchor_task_id);
      // Unknown usage can be pending reconciliation before any priced
      // invocation exists (scripted adapters, recovery before settle); an open
      // unknown_usage question is authoritative that the cost is not known.
      const masterUnknown = anchorQuestions.some(question => question.kind === 'unknown_usage' && question.status === 'open');
      const unknownPending = masterUnknown || tasks.some(task => task.openQuestions.some(question => question.kind === 'unknown_usage'));
      const masterCost = masterUnknown && ledgerCost.unknown !== true ? { ...ledgerCost, unknown: true } : ledgerCost;
      const cost = mergeCosts([masterCost, ...tasks.map(task => task.cost)]);
      if (unknownPending) cost.unknown = true;
      const used = (master?.used ?? 0) + tasks.reduce((sum, task) => sum + task.nodes.reduce((inner, node) => inner + (node.used ?? 0), 0), 0);
      const anyUnlimited = Boolean(master?.unlimited) || tasks.some(task => task.nodes.some(node => node.unlimited));
      const budget = anyUnlimited ? null : (master?.budget ?? 0) + tasks.reduce((sum, task) => sum + task.nodes.reduce((inner, node) => inner + (node.budget ?? 0), 0), 0);
      const messageCount = (store.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?').get(conversationId) as { count: number }).count;
      const knownMasterUsage = conversationMasterUsage(store, conversationId);
      const { cachedInput, cacheInput } = knownMasterUsage;
      const contextLimit = master?.model ? liveEntries().find(entry => entry.id === master.model)?.contextWindow ?? null : null;
      const contextTokens = knownMasterUsage.contextTokens;
      return {
        id: conversation.id, title: conversation.title, projectId: conversation.project_id, projectRoot: project?.root ?? null,
        archived: conversation.archived_at !== null, archivedAt: conversation.archived_at,
        paused: Boolean(anchor.paused),
        workspaceProjectId: conversation.workspace_project_id, anchorTaskId: conversation.anchor_task_id,
        createdAt: conversation.created_at, requirementVersion: anchor.requirement_version,
        // Captured synchronously with the message/stream snapshot. New attaches
        // subscribe after it instead of replaying the entire event history.
        eventCursor: (store.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events').get() as { cursor: number }).cursor,
        messages: listMessages(store, conversationId, query), messageCount,
        streams: conversationStreams(store, conversationId),
        continuations: store.db.prepare('SELECT operation_id AS operationId,resumed_operation_id AS resumedOperationId FROM rsi_continuations WHERE task_id=?').all(conversation.anchor_task_id) as { operationId: string; resumedOperationId: string | null }[],
        questions: anchorQuestions,
        proposal,
        proposalHistory,
        accepted: accepted.map(row => ({ proposalVersion: row.proposal_version, taskId: row.task_id, targetBranch: row.target_branch, acceptedAt: row.accepted_at })),
        master: master ? { nodeId: 'master', status: master.status, model: master.model, used: master.used, unlimited: Boolean(master.unlimited), budget: master.unlimited ? null : master.budget, definitionVersion: master.definition_version, cost: masterCost, questions: anchorQuestions.filter(question => question.status === 'open' && question.owner === 'user') } : null,
        telemetry: {
          model: master?.model ?? null,
          thinkingLevel: conversation.thinking_level,
          cacheHitRate: cacheInput > 0 ? cachedInput / cacheInput : null,
          cachedInput,
          cacheInput,
          contextTokens,
          contextLimit,
          contextPercent: contextTokens !== null && contextLimit ? Math.min(100, (contextTokens / contextLimit) * 100) : null,
        },
        cost, usage: { used, budget, unlimited: anyUnlimited },
        tasks,
        cursor: (store.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events').get() as { cursor: number }).cursor,
      };
    },
    async proposal(conversationId: string, version: number) {
      ensureOpen();
      if (!Number.isSafeInteger(version) || version < 1) throw new RuntimeError('invalid_input', 'A positive proposal version is required');
      const conversation = conversationRow(store, conversationId);
      const anchor = store.task(conversation.anchor_task_id);
      const proposal = conversationProposal(store, anchor.id, version, anchor.requirement_version);
      if (!proposal) throw new RuntimeError('not_found', `Proposal v${version} was not found`);
      return proposal;
    },
    async chat(conversationId: string, input: { text: string; requestId: string; attachments?: AttachmentInput[]; command?: 'compact'; source?: Json }) {
      ensureOpen();
      const conversation = conversationRow(store, conversationId);
      const attachments = cleanAttachments(input.attachments);
      const receipt = store.command(`conversation:${conversationId}`, input.requestId, {
        type: 'chat', text: input.text, attachments, command: input.command ?? null, source: input.source ?? null,
      }, () => {
        if (!input.text.trim() && !attachments.length && !input.command) throw new RuntimeError('invalid_input', 'A nonempty message, attachment or command is required');
        recoverMaster(store, conversation.anchor_task_id, 'message');
        const node = store.db.prepare("SELECT status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'").get(conversation.anchor_task_id) as { status: string } | undefined;
        const anchor = store.task(conversation.anchor_task_id);
        const state = anchor.paused || (node && ['preparing', 'running', 'blocked'].includes(node.status)) ? 'queued' : 'pending';
        const message = appendMessage(store, {
          conversationId, role: 'user', kind: 'chat', text: input.text.trim(), state,
          ...(attachments.length || input.command || input.source ? {
            data: {
              ...(attachments.length ? { attachments } : {}),
              ...(input.command ? { command: input.command } : {}),
              // Who wrote it, when it was not the user: another Agent's conversation.
              ...(input.source ? { source: input.source } : {}),
            } as unknown as Json,
          } : {}),
        });
        return { conversationId, messageId: message.id, state, cursor: message.cursor, pending: state === 'queued' };
      });
      if (options.autoWake) execution.kick();
      return receipt;
    },
    compact(conversationId: string, input: { requestId: string }) {
      ensureOpen();
      return conversations.chat(conversationId, {
        text: '压缩当前会话上下文',
        requestId: input.requestId,
        command: 'compact',
      });
    },
    async steer(conversationId: string, input: { requestId: string }) {
      ensureOpen();
      const conversation = conversationRow(store, conversationId);
      const active = store.db.prepare(`
        SELECT o.id,o.spec
        FROM operations o
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        JOIN tasks t ON t.id=o.task_id
        WHERE t.conversation_id=? AND json_extract(n.spec,'$.role')='master'
          AND o.state='dispatched' AND o.worker_active=1
        ORDER BY o.rowid DESC LIMIT 1
      `).get(conversationId) as { id: string; spec: string } | undefined;
      const messages = pendingMessages(store, conversationId, 50);
      if (!messages.length) return { conversationId, state: 'empty' as const, steered: 0, cursor: null as number | null };
      if (!active) return { conversationId, state: 'queued' as const, steered: 0, cursor: null as number | null };

      const operation = JSON.parse(active.spec) as Operation;
      const combined = messages.map(steeringText).filter(Boolean).join('\n\n');
      if (!combined) throw new RuntimeError('invalid_input', 'Queued messages do not contain steerable text');
      const steered = await execution.interrupt(active.id, combined);

      const receipt = store.transaction(() => {
        const ids = messages.map(message => message.id);
        deliverMessages(store, active.id, operation.attempt, messages, steered?.ordinal);
        const cursor = store.event(conversation.anchor_task_id, 'message.steered', {
          operationId: active.id, messageIds: ids, requestId: input.requestId,
        });
        return { conversationId, state: 'steered' as const, steered: ids.length, cursor };
      });
      return receipt;
    },
    async interrupt(conversationId: string, input: { requestId: string }) {
      ensureOpen();
      conversationRow(store, conversationId);
      const active = store.db.prepare(`
        SELECT o.id
        FROM operations o
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        JOIN tasks t ON t.id=o.task_id
        WHERE t.conversation_id=? AND json_extract(n.spec,'$.role')='master'
          AND o.state='dispatched' AND o.worker_active=1
        ORDER BY o.rowid DESC LIMIT 1
      `).get(conversationId) as { id: string } | undefined;
      if (!active) return { conversationId, state: 'idle' as const, requestId: input.requestId };
      await execution.interrupt(active.id);
      return { conversationId, state: 'interrupted' as const, requestId: input.requestId };
    },
    async bind(conversationId: string, input: { projectId: string; requestId: string }) {
      ensureOpen();
      const conversation = conversationRow(store, conversationId);
      if (!store.db.prepare('SELECT id FROM projects WHERE id=?').get(input.projectId)) throw new RuntimeError('invalid_input', 'A known project is required');
      if (configuredProjects() !== undefined && !allowedProjects().has(input.projectId)) throw new RuntimeError('invalid_input', 'The project is no longer part of the current configuration');
      // Investigation binds to a Git-ready project: plain directories are
      // initialized here, dirty repositories stop with an explicit reason.
      git.requirePrepared(input.projectId);
      return store.command(`conversation:${conversationId}`, input.requestId, { type: 'bind', projectId: input.projectId }, () => {
        const previous = conversation.project_id;
        if (previous === input.projectId) return { conversationId, taskId: conversation.anchor_task_id, changed: false, cursor: null as number | null };
        store.db.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(input.projectId, conversationId);
        store.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(input.projectId, conversation.anchor_task_id);
        let invalidated = false;
        if (previous !== null) {
          // A draft was investigated against the old project; switching the
          // project makes every existing draft unconfirmable, not just hidden.
          invalidated = true;
          store.db.prepare('UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?').run(conversation.anchor_task_id);
          store.db.prepare('UPDATE conversations SET binding_since_seq=COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id=?),0) WHERE id=?').run(conversationId, conversationId);
          appendMessage(store, { conversationId, role: 'system', kind: 'project', text: `项目已从 ${previous} 变更为 ${input.projectId}；旧草稿失效，请重新调查后生成新草稿。`, state: 'done' });
          store.event(conversation.anchor_task_id, 'conversation.rebound', { from: previous, to: input.projectId });
        } else {
          appendMessage(store, { conversationId, role: 'system', kind: 'project', text: `已绑定项目 ${input.projectId}`, state: 'done' });
        }
        return { conversationId, taskId: conversation.anchor_task_id, changed: true, invalidatedDrafts: invalidated, cursor: store.event(conversation.anchor_task_id, 'conversation.bound', { projectId: input.projectId, previous }) };
      });
    },
    async confirm(conversationId: string, input: { proposalVersion: number; targetBranch: string; requestId: string; attestation?: { actor: 'agent'; onBehalfOf: 'user'; instruction: string } }) {
      ensureOpen();
      const bound = conversationRow(store, conversationId);
      if (!bound.project_id) throw new RuntimeError('invalid_input', 'Bind a project before confirming a draft');
      if (!input.targetBranch.trim()) throw new RuntimeError('invalid_input', 'A target branch is required');
      git.requireTargetBranch(bound.project_id, input.targetBranch);
      const receipt = store.command(`conversation:${conversationId}`, input.requestId, { type: 'confirm', proposalVersion: input.proposalVersion, targetBranch: input.targetBranch, ...(input.attestation ? { actor: input.attestation.actor, onBehalfOf: input.attestation.onBehalfOf, instruction: input.attestation.instruction } : {}) }, () => {
        const conversation = conversationRow(store, conversationId);
        if (!conversation.project_id) throw new RuntimeError('invalid_input', 'Bind a project before confirming a draft');
        if (!input.targetBranch.trim()) throw new RuntimeError('invalid_input', 'A target branch is required');
        const anchor = store.task(conversation.anchor_task_id);
        const row = store.db.prepare('SELECT requirement_version,spec,decision_snapshot FROM proposals WHERE task_id=? AND version=?').get(anchor.id, input.proposalVersion) as { requirement_version: number; spec: string; decision_snapshot: string | null } | undefined;
        if (!row || anchor.latest_proposal !== input.proposalVersion || row.requirement_version !== anchor.requirement_version) throw new RuntimeError('stale_proposal', 'Only the current draft on the current requirement can be confirmed');
        if (store.db.prepare('SELECT proposal_version FROM conversation_acceptances WHERE conversation_id=? AND proposal_version=?').get(conversationId, input.proposalVersion)) throw new RuntimeError('already_accepted', 'This draft was already confirmed');
        const proposal = JSON.parse(row.spec) as Proposal;
        const taskId = randomUUID();
        const sequence = (store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count + 1;
        const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
        const phase = active_task ? 'queued' : 'running';
        // Sub-agents inherit exactly the snapshot frozen with this draft and
        // reviewed on the confirmation card; nothing from later chat or from a
        // previous project binding can slip in.
        const decisionDigest = row.decision_snapshot;
        store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,accepted_proposal,target_branch,phase,created_seq,graph_version,conversation_id,decision_digest) VALUES(?,?,?,1,1,1,?,?,?,1,?,?)')
          .run(taskId, conversation.project_id, proposal.summary, input.targetBranch, phase, sequence, conversationId, decisionDigest);
        store.db.prepare('INSERT INTO proposals(task_id,version,requirement_version,spec,decision_snapshot) VALUES(?,?,?,?,?)').run(taskId, 1, 1, row.spec, row.decision_snapshot);
        // §13.8 switchover: a draft that carries a v2 graph definition creates a v2 graph
        // (§5 graph_create takes exactly this definition). The old declarative rows would
        // put this task on the old executor, so they are skipped entirely. The confirmed
        // record above is shared by both paths - it is the confirmation, not the run.
        if (proposal.definition) {
          materializeGraph(new KernelStore(store), taskId, parseGraphDefinition(proposal.definition), 'Confirmed conversation draft');
        } else {
        store.db.prepare('INSERT INTO graph_revisions(task_id,version,spec,reason,base_version) VALUES(?,1,?,?,0)').run(taskId, row.spec, 'Confirmed conversation draft');
        for (const node of proposal.nodes) {
          const instanceId = node.kind === 'agent' ? randomUUID() : null;
          store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, node.id, canonicalJson(node), instanceId);
          if (instanceId) insertInstance(instanceId, taskId, node.id, node.definitionVersion ?? null, node.model ?? null);
          createActivation(store, taskId, node.id, 1);
        }
        }
        if (phase === 'running') store.db.prepare('UPDATE runtime SET active_task=?').run(taskId);
        // The anchor requirement advances on confirmation only: chat never
        // bumps it, and old drafts become unconfirmable immediately.
        store.db.prepare('UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?').run(anchor.id);
        store.db.prepare('INSERT INTO conversation_acceptances VALUES(?,?,?,?,?)').run(conversationId, input.proposalVersion, taskId, input.targetBranch, Date.now());
        appendMessage(store, { conversationId, role: 'system', kind: 'confirmed', text: `已确认草稿 v${input.proposalVersion}，创建功能任务并${phase === 'running' ? '开始执行' : '排队'}（目标分支 ${input.targetBranch}）`, data: { taskId, proposalVersion: input.proposalVersion, targetBranch: input.targetBranch } });
        store.event(taskId, 'task.created', { request: proposal.summary, conversationId, configRevision: options.live?.revision() ?? options.config?.revision() ?? null });
        return { conversationId, taskId, targetBranch: input.targetBranch, cursor: store.event(anchor.id, 'conversation.confirmed', { taskId, proposalVersion: input.proposalVersion, targetBranch: input.targetBranch }) };
      });
      git.prepareTask(receipt.taskId, input.targetBranch);
      return receipt;
    },
    pause(conversationId: string, requestId: string) {
      ensureOpen();
      return user.task(conversationRow(store, conversationId).anchor_task_id).pause(requestId);
    },
    resume(conversationId: string, requestId: string) {
      ensureOpen();
      return user.task(conversationRow(store, conversationId).anchor_task_id).resume(requestId);
    },
    /** Drop one still-queued message from this conversation. Cancelling is
     * scoped to state `queued` (the delivered history and the running turn are
     * never touched) and idempotent through the shared requestId command log. */
    cancelMessage(conversationId: string, input: { messageId: string; requestId: string }) {
      ensureOpen();
      const conversation = conversationRow(store, conversationId);
      if (!input.messageId?.trim()) throw new RuntimeError('invalid_input', 'A messageId is required');
      return store.command(`conversation:${conversationId}`, input.requestId, {
        type: 'cancel_message', messageId: input.messageId,
      }, () => {
        const result = cancelQueuedMessage(store, conversationId, input.messageId);
        return {
          conversationId,
          messageId: input.messageId,
          state: result.state,
          cancelled: result.cancelled,
          cursor: result.changed
            ? store.event(conversation.anchor_task_id, 'message.cancelled', { messageId: input.messageId })
            : null as number | null,
        };
      });
    },
    watch(conversationId: string, after = 0): TaskWatch {
      ensureOpen();
      conversationRow(store, conversationId);
      if (!Number.isSafeInteger(after) || after < 0) throw new RuntimeError('invalid_cursor', 'Invalid event cursor');
      const controller = new AbortController();
      // The stream covers the anchor and every task the conversation created,
      // re-reading the task set each iteration so a new task is included
      // without reconnecting. The global event cursor stays monotonic.
      const iterator = (async function* () {
        let cursor = after;
        while (!closed && !controller.signal.aborted) {
          const wake = store.waitForChange(controller.signal);
          const ids = conversationTaskIds(store, conversationId);
          const rows = store.db.prepare(`SELECT cursor,task_id,type,data,timestamp FROM events WHERE task_id IN (${ids.map(() => '?').join(',')}) AND cursor>? ORDER BY cursor LIMIT 100`)
            .all(...ids, cursor) as { cursor: number; task_id: string; type: string; data: string; timestamp: number }[];
          if (rows.length) {
            wake.cancel();
            for (const row of rows) {
              if (controller.signal.aborted) return;
              cursor = row.cursor;
              yield { cursor: row.cursor, taskId: row.task_id, type: row.type, data: JSON.parse(row.data) as Json, timestamp: row.timestamp } as TaskUpdate;
            }
          } else {
            await Promise.race([wake.promise, new Promise(resolve => setTimeout(resolve, 250))]);
            wake.cancel();
          }
        }
      })();
      return {
        [Symbol.asyncIterator]() { return this; },
        next: () => iterator.next(),
        return: async () => { controller.abort(); return iterator.return(); },
      };
    },
    attachment(messageId: string, index: number) {
      ensureOpen();
      if (!Number.isSafeInteger(index) || index < 0) throw new RuntimeError('not_found', 'Attachment not found');
      const row = store.db.prepare('SELECT data FROM messages WHERE id=?').get(messageId) as { data: string | null } | undefined;
      const attachment = row?.data ? JSON.parse(row.data).attachments?.[index] : undefined;
      if (!attachment || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.type) || typeof attachment.data !== 'string') {
        throw new RuntimeError('not_found', 'Image attachment not found');
      }
      return { type: String(attachment.type), bytes: Buffer.from(attachment.data, 'base64') };
    },
    history(conversationId: string, query: { after?: number; before?: number; limit?: number } = {}) {
      ensureOpen();
      conversationRow(store, conversationId);
      return { messages: listMessages(store, conversationId, query) };
    },
    events(conversationId: string, after = 0, limit = 200) {
      ensureOpen();
      const ids = conversationTaskIds(store, conversationId);
      const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
      return (store.db.prepare(`SELECT cursor,task_id,type,data,timestamp FROM events WHERE task_id IN (${ids.map(() => '?').join(',')}) AND cursor>? ORDER BY cursor LIMIT ?`).all(...ids, after, cap) as { cursor: number; task_id: string; type: string; data: string; timestamp: number }[])
        .map(row => ({ cursor: row.cursor, type: row.type, data: JSON.parse(row.data) as Json, timestamp: row.timestamp, taskId: row.task_id }));
    },
  };

  const runtime = {
    /** Preview the next operation's configuration, without loading capability executors. */
    async agentContextPreview(conversationId?: string) {
      ensureOpen();
      const library = options.agentContext;
      if (!library) throw new RuntimeError('invalid_config', 'Agent context library is unavailable');
      const view = conversationId ? await conversations.view(conversationId, { limit: 1 }) : undefined;
      const definitions = catalog.listDefinitions();
      const latest = definitions.find(item => item.id === 'main') ?? definitions.find(item => item.id === 'master');
      const latestDefinitionVersion = masterDefinitionVersion() ?? (latest ? `${latest.id}@${latest.version}` : null);
      // The master follows the latest definition of its own recipe on the next turn
      // (see Execution.refreshMasterDefinition), so the preview has to describe that
      // same version instead of the one the instance last ran.
      const masterVersion = view?.master?.definitionVersion;
      const masterId = masterVersion?.split('@')[0];
      const masterLatest = masterId
        ? definitions.filter(item => item.id === masterId).sort((left, right) => right.version - left.version)[0]
        : undefined;
      const definitionVersion = masterLatest && masterId
        ? `${masterId}@${masterLatest.version}`
        : (masterVersion ?? latestDefinitionVersion);
      const definitionId = definitionVersion?.split('@')[0];
      const action = options.master?.action ?? 'master';
      const workspace = view?.master && view.anchorTaskId
        ? runtime.agentWorkspace(view.anchorTaskId, view.master.nodeId) : view?.projectRoot ?? null;
      const assembly = await openAgentContextAssembly({
        catalog, library, workspace, action, role: 'master', retrieval: true,
        ...(view?.projectRoot ? { skillProjectRoot: view.projectRoot } : {}),
        rsi: Boolean(options.rsi?.available) && isFullAccess(runtime.currentAccessPolicy()),
        definitionVersion: definitionVersion ?? 'main@unknown',
        fullAccess: isFullAccess(runtime.currentAccessPolicy()),
        bootstrap: {
          ...(definitionId && options.catalog?.bootstrapPrompts?.[definitionId]
            ? { agent: options.catalog.bootstrapPrompts[definitionId]! } : {}),
          ...(options.catalog?.bootstrapToolPrompt !== undefined ? { tool: options.catalog.bootstrapToolPrompt } : {}),
        },
        ...(definitionId && options.catalog?.capabilityRoot ? {
          skillFolder: agentSkillsDir(definitionId, resolve(options.catalog.capabilityRoot, '..')),
          skillOwnedRoots: agentSkillOwnedRoots({
            capabilityRoot: options.catalog.capabilityRoot,
            stateDir,
          }),
        } : {}),
      });
      const preview = await assembly.preview({
        role: 'master', run: true, fetch: true, catalog: true,
        // The real operation offers these whenever a master turn runs inside a conversation; the
        // preview must say the same thing, or the settings panel would show a smaller toolbox than
        // the one the next turn really gets.
        conversations: { read: true, write: true },
        // A master turn is not given `peers`: same-graph messaging belongs to a subagent, and a
        // preview that claimed otherwise would be the panel's usual lie about the tool surface.
        peers: false,
        artifacts: agentArtifactAccess({ role: 'master', action }),
        supervisor: {
          validateProposal: true, graphState: true, taskStatus: true, listProjects: true,
          bindProject: true, listProblems: true, resolveProblem: true, withdrawDraft: true, confirmDraft: true,
          pendingHumanChecks: true, reviewHumanCheck: true,
          controlTask: true,
        },
        ...(options.systemContext ? { systemContext: {
          systemSummary: Boolean(options.systemContext.systemSummary),
          systemDiagnostics: Boolean(view), proposeSystemChange: Boolean(view),
          applySystemChange: Boolean(view),
        } } : {}),
        ...(options.rsi ? { rsi: {
          status: isFullAccess(runtime.currentAccessPolicy()),
          apply: Boolean(options.rsi.available) && isFullAccess(runtime.currentAccessPolicy()),
        } } : {}),
      });
      return {
        ...await library.view({
          models: '{{models}}', requirementVersion: '{{requirementVersion}}',
          fullAccessInstruction: '{{fullAccessInstruction}}', retrievalNote: '{{retrievalNote}}',
        }), disabledTools: assembly.disabledTools,
        docsRoot: preview.docsRoot, definitionVersion, latestDefinitionVersion,
        tools: preview.tools, capabilities: preview.capabilities,
        // The exact string one real send carried, or null when this conversation has not sent yet.
        sent: view?.anchorTaskId ? store.conversationSystemPrompt(view.anchorTaskId) : null,
      };
    },
    currentAccessPolicy(): ResolvedAccessPolicy {
      ensureOpen();
      return resolveAccessPolicy(options.access?.() ?? standardAccessPolicy(), {
        home: homedir(),
        stateDir,
        graphHome: options.agentContext ? dirname(options.agentContext.root) : join(homedir(), '.graph'),
      });
    },
    /** Scheduler facts: which credentials are busy and which requests wait. */
    modelLimits(): { active: Record<string, number>; queued: Record<string, number> } {
      ensureOpen();
      return modelScheduler.snapshot();
    },
    /** Model ids bound to tasks that have not finished, for config deletion guards. */
    modelsInUse(): string[] {
      ensureOpen();
      return (store.db.prepare(`SELECT DISTINCT i.model AS model FROM nodes n JOIN instances i ON i.id=n.instance_id JOIN tasks t ON t.id=n.task_id
        WHERE t.phase IN ('discussing','running','queued') AND n.status NOT IN ('succeeded','skipped') AND i.model IS NOT NULL`).all() as { model: string }[]).map(row => row.model);
    },
    user,
    /** Resolved questions across feature tasks and conversation anchors. */
    inboxHistory(limit = 100) {
      ensureOpen();
      const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
      return (store.db.prepare(`SELECT q.id,q.task_id AS taskId,q.node_id AS nodeId,q.kind,q.status,q.data,q.answer,q.owner,
        t.request,t.project_id AS projectId,t.conversation_id AS conversationId
        FROM questions q JOIN tasks t ON t.id=q.task_id
        WHERE q.status='resolved' AND q.owner='user'
        ORDER BY q.rowid DESC LIMIT ?`).all(cap) as {
        id: string; taskId: string; nodeId: string; kind: string; status: string; data: string; answer: string | null; owner: string;
        request: string; projectId: string; conversationId: string | null;
      }[]).map(row => ({
        id: row.id, taskId: row.taskId, nodeId: row.nodeId, kind: row.kind, status: row.status, owner: row.owner,
        data: JSON.parse(row.data) as Json,
        answer: row.answer ? JSON.parse(row.answer) as Json : null,
        request: row.request, projectId: row.projectId, conversationId: row.conversationId,
      }));
    },
    /** Talent detail plus per-metric experience statistics from the ledger. */
    talent(id: string, options: { version?: number; allVersions?: boolean } = {}) {
      ensureOpen();
      return {
        detail: talentDetail(store, id, options, (capabilityId, version) => catalog.capability(capabilityId, version)),
        experience: talentExperience(store, id, options),
      };
    },
    async sendNodeMessage(taskId: string, nodeId: string, input: { text: string; requestId: string }) {
      ensureOpen();
      const receipt = await sendNodeMessage(store, execution, taskId, nodeId, input);
      if (options.autoWake) execution.kick();
      return receipt;
    },
    /** One Agent of a graph messaging another; delivered like a user prompt to the target node. */
    async sendPeerMessage(taskId: string, from: string, input: { to: string; text: string; requestId: string }) {
      ensureOpen();
      const receipt = await sendPeerMessage(store, execution, taskId, from, input);
      if (options.autoWake) execution.kick();
      return receipt;
    },
    graphMessages(taskId: string) {
      ensureOpen();
      store.task(taskId);
      // A peer message is recorded where it is delivered: a chat entry on the target node carrying
      // the sender (`node-messages.ts` writes it). Reading it here is what draws the canvas's message
      // arcs, and reading anything else would draw a picture of a mechanism that no longer exists -
      // the old `messages.kind='agent_message'` rows stopped being written when peer delivery was
      // changed to hand the words to the target node, which left this reader reporting an empty
      // graph while real messages went between its nodes.
      return (store.db.prepare(`SELECT id,json_extract(data,'$.from') AS source,node_id AS target,text,created_at AS createdAt
        FROM node_entries WHERE task_id=? AND kind='chat'
        AND json_extract(data,'$.peer')=1 AND json_extract(data,'$.from') IS NOT NULL ORDER BY seq`).all(taskId) as {
          id: string; source: string; target: string; text: string; createdAt: number;
        }[]);
    },
    graphHandoffs(taskId: string) {
      ensureOpen();
      store.task(taskId);
      const rows = store.db.prepare(`SELECT r.node_id AS target,r.operation_id AS operationId,h.package,h.created_at AS createdAt
        FROM context_handoffs h JOIN context_resolutions r ON r.handoff_id=h.id
        WHERE h.task_id=? ORDER BY h.created_at,r.rowid`).all(taskId) as {
          target: string; operationId: string; package: string; createdAt: number;
        }[];
      return rows.flatMap(row => {
        const parsed = JSON.parse(row.package) as { predecessorHandoffs?: import('./types.ts').PredecessorHandoffProjection[] };
        return (parsed.predecessorHandoffs ?? []).map(projection => ({
          id: `${projection.sourceOperationId}:${row.operationId}`,
          source: projection.sourceNodeId, target: row.target, mode: projection.mode,
          text: renderPredecessorHandoffs([projection]), createdAt: row.createdAt,
        }));
      });
    },
    /** Read-only node detail: real session entries, operations and usage. */
    nodeRun(taskId: string, nodeId: string, query: { after?: number; before?: number; limit?: number } = {}) {
      ensureOpen();
      try {
        return nodeRunView(store, taskId, nodeId, query);
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== 'not_found') throw error;
        // A container has no instance of its own: summarize its children so the
        // graph view can drill into the group without a dead route. A task without a graph has
        // no containers either - the original not_found is the honest answer, and asking
        // loadGraph about a draft-less task used to throw a TypeError instead.
        let graph: ReturnType<typeof loadGraph>;
        try {
          graph = loadGraph(store, taskId);
        } catch {
          throw error;
        }
        if (!graph.containers().some(item => item.id === nodeId)) throw error;
        const container = graph.containers().find(item => item.id === nodeId)!;
        const rows = store.db.prepare('SELECT id,spec,status FROM nodes WHERE task_id=?').all(taskId) as { id: string; spec: string; status: string }[];
        const children = rows.map(row => ({ id: row.id, status: row.status, spec: JSON.parse(row.spec) as { container?: string } }))
          .filter(row => row.spec.container === nodeId)
          .map(row => ({ id: row.id, status: row.status }));
        const childIds = new Set(children.map(child => child.id));
        for (const nested of graph.containers()) if (nested.parent === nodeId) childIds.add(nested.id);
        return {
          taskId, nodeId,
          node: { id: nodeId, kind: 'container', action: 'container', role: null, status: children.every(child => child.status === 'succeeded') ? 'succeeded' : 'running', activationId: '', outputVersion: 0, stallCount: 0 },
          instance: null, session: null, context: null, capabilities: [], capabilityUsage: [],
          operations: [], invocations: [], questions: [], evidence: [],
          entries: [], entryCount: 0, hasOlder: false, hasNewer: false,
          childContainers: [...childIds], children,
          timing: { totalMs: null, runMs: null, waitingMs: 0 },
          phase: store.task(taskId).phase,
          container: { id: container.id, parent: container.parent ?? null, outputs: container.outputs },
        };
      }
    },
    /** What one node really sent: the recorded system prompt, its tools and its briefing. */
    nodePrompt(taskId: string, nodeId: string) {
      ensureOpen();
      return nodePromptView(store, taskId, nodeId);
    },
    /** Read-only workspace identity for prompt preview and diagnostics. */
    agentWorkspace(taskId: string, nodeId: string) {
      ensureOpen();
      const row = store.db.prepare('SELECT instance_id,spec FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as
        { instance_id: string | null; spec: string } | undefined;
      if (!row) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
      const task = store.task(taskId);
      const spec = JSON.parse(row.spec) as NodeSpec;
      const workspace = git.workspace(taskId, row.instance_id, nodeId, spec.kind, spec.action);
      if (workspace) return workspace;
      const project = store.db.prepare('SELECT root FROM projects WHERE id=?').get(task.project_id) as { root: string } | undefined;
      return project?.root ?? null;
    },
    /** Read-only path completion for conversation @-references. */
    projectEntries(projectId: string, query = '', limit = 80) {
      ensureOpen();
      const configured = configuredProjects();
      if (configured !== undefined && !allowedProjects().has(projectId)) {
        throw new RuntimeError('invalid_input', 'The project is no longer part of the current configuration');
      }
      return git.visiblePaths(projectId, query, limit);
    },
    /** Business project Git admission: explicit preparation and state reads. */
    projects: {
      async prepare(input: { projectId: string; requestId: string; initialize?: boolean; createBaseline?: boolean }) {
        ensureOpen();
        const configured = configuredProjects();
        if (configured !== undefined && !allowedProjects().has(input.projectId)) throw new RuntimeError('invalid_input', 'The project is no longer part of the current configuration');
        const payload = { type: 'prepare', projectId: input.projectId, initialize: input.initialize ?? true, createBaseline: input.createBaseline ?? false };
        const encoded = canonicalJson(payload);
        const previous = store.db.prepare('SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?').get('projects', input.requestId) as { payload: string; receipt: string } | undefined;
        if (previous) {
          if (previous.payload !== encoded) throw new RuntimeError('idempotency_conflict', 'requestId was already used with different content');
          return JSON.parse(previous.receipt) as { state: string } & Record<string, unknown>;
        }
        // External Git effects are never executed inside the SQLite transaction:
        // the intent is durable first, the effect runs outside, the result is
        // settled separately so a crash can be recognized after restart.
        const opId = randomUUID();
        // Snapshot the identity before the effect so crash recovery can tell
        // "our commit already happened" from "the worktree changed later".
        const headBefore = git.projectHead(input.projectId);
        const fingerprintBefore = git.projectFingerprint(input.projectId);
        store.transaction(() => {
          store.db.prepare('INSERT INTO git_ops VALUES(?,?,?,?,?,?)').run(opId, `project:${input.projectId}`, 'prepare', 'intent',
            canonicalJson({ payload, requestId: input.requestId, headBefore, fingerprintBefore }), null);
        });
        let prep;
        try {
          prep = git.prepareProject(input.projectId, { initialize: payload.initialize, createBaseline: payload.createBaseline });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          store.transaction(() => {
            store.db.prepare("UPDATE git_ops SET state='failed', result=? WHERE id=?").run(canonicalJson({ reason }), opId);
            store.db.prepare('INSERT OR REPLACE INTO commands VALUES(?,?,?,?)').run('projects', input.requestId, encoded, canonicalJson({ state: 'failed', reason, retryable: true }));
          });
          throw error;
        }
        return settlePrepare(opId, input.requestId, payload, prep, { state: prep.state, baselineSha: prep.baselineSha });
      },
      preparation(projectId: string) {
        ensureOpen();
        const prep = git.preparation(projectId);
        if (!prep) throw new RuntimeError('not_found', `No preparation recorded for ${projectId}`);
        return prep;
      },
    },
    artifacts: {
      list(taskId: string, query: {
        artifactId?: string; namespace?: string; prefix?: string; schema?: string; tag?: string; trust?: 'unverified' | 'reviewed' | 'accepted';
        includeRetired?: boolean; latestOnly?: boolean; limit?: number; cursor?: string;
      } = {}) {
        ensureOpen();
        return artifacts.list({ taskId, ...query });
      },
      get(taskId: string, artifactId: string, version?: number, scope?: 'task' | 'project') {
        ensureOpen();
        return artifacts.get(taskId, artifactId, version, scope);
      },
      read(taskId: string, artifactId: string, version: number, maxBytes?: number, scope?: 'task' | 'project') {
        ensureOpen();
        return artifacts.read(taskId, artifactId, version, maxBytes ?? 262_144, scope);
      },
      retire(input: { taskId: string; artifactId: string; version: number; reason: string; requestId: string }) {
        ensureOpen();
        return artifacts.retire(input.taskId, input.artifactId, input.version, input.reason, input.requestId);
      },
      promote(input: { taskId: string; artifactId: string; version: number; requestId: string }) {
        ensureOpen();
        return artifacts.promote({ ...input, promotedBy: 'user' });
      },
      /** The project's own artifacts, independent of any task in it. */
      listProject(projectId: string, query: {
        artifactId?: string; namespace?: string; prefix?: string; schema?: string; tag?: string; trust?: 'unverified' | 'reviewed' | 'accepted';
        includeRetired?: boolean; latestOnly?: boolean; limit?: number; cursor?: string;
      } = {}) {
        ensureOpen();
        return artifacts.listProject(projectId, query);
      },
      listConversation(conversationId: string, query: {
        artifactId?: string; namespace?: string; prefix?: string; schema?: string; tag?: string; trust?: 'unverified' | 'reviewed' | 'accepted';
        includeRetired?: boolean; latestOnly?: boolean; limit?: number;
      } = {}) {
        ensureOpen();
        const ids = conversationTaskIds(store, conversationId);
        // Every task in the conversation sees the same project-scoped artifacts, so the union has to
        // be deduplicated by artifact+version or a shared artifact would be listed once per task.
        const seen = new Map<string, (typeof artifacts extends never ? never : ReturnType<typeof artifacts.list>['artifacts'][number])>();
        for (const taskId of ids) {
          for (const record of artifacts.list({ taskId, ...query, limit: 200 }).artifacts) {
            seen.set(`${record.artifactId}@${record.version}`, record);
          }
        }
        const records = [...seen.values()].sort((left, right) => right.createdAt - left.createdAt);
        const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 100)));
        return {
          artifacts: records.slice(0, limit),
          nextCursor: null,
          total: records.length,
        };
      },
    },
    conversations,
    host: {
      async ackRsiRestart(id: string) {
        ensureOpen();
        if (!options.rsi) throw new RuntimeError('rsi_unavailable', 'RSI is unavailable');
        const result = await options.rsi.ackRestart(id, store);
        if (result.cleared && options.autoWake) execution.kick();
        return result;
      },
      async runReady() { ensureOpen(); return execution.runReady(); },
      /** Nodes still pending although their dependencies are satisfied: a one-shot drain left work
       * behind. The host re-scans every tick so production never strands; callers that expect the
       * graph drained can assert this is empty instead of guessing why a node never ran. */
      strandedNodes() { ensureOpen(); return execution.strandedNodes(); },
      /** Read-only candidate check: a hot config that moves the root of a
       * project with tasks in flight must be rejected before anything is
       * persisted or activated. */
      checkProjects(projects: ProjectConfig[]) {
        ensureOpen();
        for (const project of projects) {
          if (!project.id.trim() || !project.root.trim()) throw new RuntimeError('invalid_input', 'Project identity and root must be nonempty strings');
          const root = resolve(project.root);
          const previous = store.db.prepare('SELECT root FROM projects WHERE id=?').get(project.id) as { root: string } | undefined;
          if (!previous || previous.root === root) continue;
          const active = (store.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id=? AND phase IN ('discussing','running','queued')").get(project.id) as { count: number }).count;
          if (active) throw new RuntimeError('project_conflict', `Project ${project.id} has tasks in flight; its root cannot change until they finish`);
        }
      },
      /** Register hot-added projects and reject root moves while tasks are in
       * flight. Removed projects keep their history but lose new dispatch. */
      syncProjects() {
        ensureOpen();
        const configured = configuredProjects();
        if (!configured) return;
        this.checkProjects(configured);
        store.transaction(() => {
          for (const project of configured) {
            const root = resolve(project.root);
            const grants = canonicalJson([...new Set(project.grants ?? [])].sort());
            const previous = store.db.prepare('SELECT root FROM projects WHERE id=?').get(project.id) as { root: string } | undefined;
            if (!previous) {
              store.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(project.id, root, grants);
              continue;
            }
            if (previous.root !== root) store.db.prepare('UPDATE projects SET root=? WHERE id=?').run(root, project.id);
          }
        });
      },
      async drive() { ensureOpen(); return execution.drive(); },
      async pump() { ensureOpen(); return execution.pump(); },
      async report(id: string, generation: number, result: OperationResult) { ensureOpen(); execution.report(id, generation, result); },
      async reconcile(id: string) { ensureOpen(); await execution.reconcile(id); },
      /** Create master nodes for pending tasks after a hot configuration apply. */
      recoverMasters() { ensureOpen(); return recoverMasterNodes({ reviveParked: true }); },
    },
    supervisor(taskId: string) {
      ensureOpen(); store.task(taskId);
      /** Control reaches this task and its conversation's other tasks, never a sibling conversation. */
      const controlTarget = (requested?: string): string => {
        const target = requested?.trim() ? requested.trim() : taskId;
        if (target === taskId) return target;
        const conversation = store.task(taskId).conversation_id;
        if (!conversation || store.task(target).conversation_id !== conversation) {
          throw new RuntimeError('invalid_input', 'Control reaches only tasks of this conversation');
        }
        return target;
      };
      // Give workers this scoped object, never the user or host runtime object.
      return {
        /** Task control asked for by the main Agent itself: every action carries its reason
         * and is recorded under the agent's own command scope, so the audit trail shows who
         * acted instead of borrowing the user's scope. */
        async controlTask(input: {
          action: 'pause' | 'resume' | 'abandon' | 'set_budget' | 'steer';
          taskId?: string;
          nodeId?: string;
          text?: string;
          tokens?: number | null;
          reason?: string;
          requestId: string;
        }) {
          ensureOpen();
          if (!input.requestId || input.requestId.length > 200) throw new RuntimeError('invalid_input', 'A bounded requestId is required');
          const target = controlTarget(input.taskId);
          const scope = `supervisor:${taskId}`;
          if (input.action === 'pause' || input.action === 'resume') {
            const paused = input.action === 'pause';
            let stoppedMaster = false;
            const receipt = store.command(scope, input.requestId, { type: input.action, taskId: target }, () => {
              store.db.prepare('UPDATE tasks SET paused=? WHERE id=?').run(Number(paused), target);
              if (paused) {
                openPause(store, target);
                // Remember the live master turn so an explicit resume continues it.
                const active = store.db.prepare(`SELECT o.id FROM operations o
                  JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
                  WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
                    AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid DESC LIMIT 1`).get(target) as { id: string } | undefined;
                if (active) stoppedMaster = awaitPauseContinuation(store, input.requestId, target, active.id);
              } else {
                closePause(store, target);
                resumePauseContinuations(store, target);
              }
              return { taskId: target, cursor: store.event(target, paused ? 'task.pause_requested' : 'task.resumed', { actor: 'agent', reason: input.reason ?? null }) };
            });
            if (paused && stoppedMaster) await execution.stopActiveMasterTurns(target);
            else if (!paused && options.autoWake) execution.kick();
            return receipt;
          }
          if (input.action === 'abandon') {
            const reason = input.reason?.trim();
            if (!reason) throw new RuntimeError('invalid_input', 'Abandoning a task needs a recorded reason');
            return store.command(scope, input.requestId, { type: 'abandon', taskId: target, reason }, () => ({
              taskId: target,
              cursor: execution.abandon(target, reason, { allowMasterTurn: true }),
            }));
          }
          if (input.action === 'set_budget') {
            const nodeId = input.nodeId?.trim();
            if (!nodeId) throw new RuntimeError('invalid_input', 'set_budget needs the node whose budget changes');
            const tokens = input.tokens;
            if (tokens === undefined) throw new RuntimeError('invalid_input', 'set_budget needs tokens: a positive integer or null for unlimited');
            if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) throw new RuntimeError('invalid_input', 'Budget must be a positive integer or null');
            // A cap below what one dispatch of this node reserves is not refused - it is the caller's
            // decision - but it stops that node (the running turn too) and blocks it asking a person.
            // Nothing else in the receipt could tell the caller that it starved its own node, so name
            // the number it cannot see anywhere else.
            const specRow = store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(target, nodeId) as { spec: string } | undefined;
            const action = specRow ? (JSON.parse(specRow.spec) as { action?: string }).action : undefined;
            const reservation = execution.reserveTokensFor(action);
            const warning = tokens !== null && reservation !== undefined && tokens < reservation
              ? `这个上限（${tokens}）低于该节点一次派发所需的预留 ${reservation} tokens：它下一次派发（包括正在跑的这一回合）会被预算挡住并停下来问人。`
              : undefined;
            return store.command(scope, input.requestId, { type: 'set_budget', taskId: target, nodeId, tokens }, () => {
              const instance = store.db.prepare('SELECT id FROM instances WHERE task_id=? AND node_id=?').get(target, nodeId) as { id: string } | undefined;
              if (!instance) throw new RuntimeError('not_found', 'Unknown agent node');
              setBudget(store, instance.id, tokens);
              store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'")
                .run(canonicalJson({ type: 'set_budget', tokens }), target, nodeId);
              return {
                taskId: target, nodeId, tokens, ...(warning ? { warning } : {}),
                cursor: store.event(target, 'instance.budget_changed', { nodeId, tokens, actor: 'agent', ...(warning ? { warning } : {}) }),
              };
            });
          }
          // Steering is the one action whose effect happens outside a command transaction:
          // the message has to reach a live turn first, and only then is the receipt recorded.
          const nodeId = input.nodeId?.trim();
          const text = input.text?.trim();
          if (!nodeId) throw new RuntimeError('invalid_input', 'steer needs the node whose running turn receives the message');
          if (!text) throw new RuntimeError('invalid_input', 'A nonempty steering message is required');
          const active = activeOperationForNode(store, target, nodeId);
          if (!active) throw new RuntimeError('steering_unavailable', `Node ${nodeId} has no running turn to steer`);
          const steered = await execution.steer(active.id, text);
          return store.transaction(() => ({
            taskId: target, nodeId, operationId: active.id, steered: steered?.ordinal ?? null,
            cursor: store.event(target, 'operation.steered', { nodeId, operationId: active.id, actor: 'agent', text }),
          }));
        },
        /** The user asked in chat for this confirmation, so the record must show who
         * really acted and carry their words: the console click and this call stay
         * distinguishable in the command log. */
        async confirmDraft(input: { proposalVersion: number; targetBranch: string; instruction: string; requestId: string }) {
          ensureOpen();
          if (!input.instruction.trim()) throw new RuntimeError('invalid_input', 'An instruction is required: record the words that authorised this confirmation');
          const conversationId = store.task(taskId).conversation_id;
          if (!conversationId) throw new RuntimeError('invalid_input', 'This task has no conversation to confirm');
          return runtime.conversations.confirm(conversationId, {
            proposalVersion: input.proposalVersion,
            targetBranch: input.targetBranch,
            requestId: input.requestId,
            attestation: { actor: 'agent', onBehalfOf: 'user', instruction: input.instruction.trim() },
          });
        },
        async propose(proposal: Proposal, requestId: string): Promise<ProposalReceipt> {
          ensureOpen();
          return store.command(`supervisor:${taskId}`, requestId, { type: 'propose', proposal }, () => {
            const task = store.task(taskId);
            if (task.accepted_proposal !== null) throw new RuntimeError('requirements_locked', 'Confirmed task scope is immutable in M1');
            if (task.requirement_version !== proposal.requirementVersion) throw new RuntimeError('stale_requirement', 'Proposal uses an old requirement version');
            validateProposal(proposal);
            const version = task.latest_proposal + 1;
            // Freeze what the user will review: master-authored decisions when
            // present, otherwise the consumed user messages of this project
            // binding (delivered only, so unreviewed pending chat stays out).
            const conversation = conversationForTask(store, taskId);
            const declared = Array.isArray(proposal.decisions);
            const curated = (proposal.decisions ?? []).map(item => item.trim()).filter(Boolean);
            let snapshot: string | null = null;
            // An explicit list (including []) is the master's authoritative
            // snapshot: [] freezes no constraints and must not be backfilled
            // from chat. Only a missing field keeps the compatibility fallback.
            if (declared) snapshot = curated.map(item => `- ${item}`).join('\n');
            else if (conversation) {
              const since = conversationRow(store, conversation.id).binding_since_seq;
              const scope = "conversation_id=? AND role='user' AND state='delivered' AND seq>?";
              const count = store.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${scope}`).get(conversation.id, since) as { n: number };
              const rows = count.n <= DECISION_DIGEST_MAX_MESSAGES
                ? store.db.prepare(`SELECT seq,text FROM messages WHERE ${scope} ORDER BY seq`).all(conversation.id, since) as { seq: number; text: string }[]
                : [
                    ...store.db.prepare(`SELECT seq,text FROM messages WHERE ${scope} ORDER BY seq LIMIT ?`).all(conversation.id, since, DECISION_DIGEST_HEAD),
                    ...(store.db.prepare(`SELECT seq,text FROM messages WHERE ${scope} ORDER BY seq DESC LIMIT ?`).all(conversation.id, since, DECISION_DIGEST_TAIL) as { seq: number; text: string }[]).reverse(),
                  ] as { seq: number; text: string }[];
              const lines = rows.filter(row => statesADecision(row.text)).map(row => `- [msg ${row.seq}] ${row.text.slice(0, 240)}`);
              // Over budget: give way from the middle, so neither end is sacrificed.
              while (lines.length > 1 && lines.join('\n').length > DECISION_DIGEST_MAX_CHARS) lines.splice(Math.floor((lines.length - 1) / 2), 1);
              if (lines.length) snapshot = lines.join('\n');
            }
            store.db.prepare('INSERT INTO proposals(task_id,version,requirement_version,spec,decision_snapshot) VALUES(?,?,?,?,?)')
              .run(taskId, version, proposal.requirementVersion, canonicalJson(proposal), snapshot);
            store.db.prepare('UPDATE tasks SET latest_proposal=? WHERE id=?').run(version, taskId);
            return { taskId, proposalVersion: version, cursor: store.event(taskId, 'proposal.created', { proposalVersion: version }) };
          });
        },
        /**
         * Withdraw the current unconfirmed draft. The version is retired instead
         * of deleted, so chat and console can still show what was proposed, and
         * `latest_proposal` advances to the next free number: the digest then
         * reports no draft, confirmation is refused as stale, and a later
         * propose keeps a monotonic version. Setting it back to 0 would make the
         * next propose reuse version 1 and fail the proposals primary key.
         */
        async withdrawDraft(input: { proposalVersion: number; reason?: string; requestId: string }) {
          ensureOpen();
          return store.command(`supervisor:${taskId}`, input.requestId, { type: 'withdraw', proposalVersion: input.proposalVersion }, () => {
            const task = store.task(taskId);
            const row = store.db.prepare('SELECT version FROM proposals WHERE task_id=? AND version=?').get(taskId, input.proposalVersion) as { version: number } | undefined;
            if (!row) throw new RuntimeError('not_found', 'That draft does not exist');
            if (task.latest_proposal !== input.proposalVersion) throw new RuntimeError('stale_proposal', 'Only the current draft can be withdrawn');
            if (task.accepted_proposal !== null) throw new RuntimeError('requirements_locked', 'A confirmed draft cannot be withdrawn');
            const conversation = conversationForTask(store, taskId);
            if (conversation && store.db.prepare('SELECT proposal_version FROM conversation_acceptances WHERE conversation_id=? AND proposal_version=?').get(conversation.id, input.proposalVersion)) {
              throw new RuntimeError('already_accepted', 'This draft was already confirmed');
            }
            const next = input.proposalVersion + 1;
            store.db.prepare('UPDATE tasks SET latest_proposal=? WHERE id=?').run(next, taskId);
            const reason = (input.reason ?? '').trim();
            if (conversation) appendMessage(store, {
              conversationId: conversation.id, role: 'system', kind: 'project', state: 'done',
              text: reason
                ? `草稿 v${input.proposalVersion} 已作废：${reason}。请重新调查后生成新草稿。`
                : `草稿 v${input.proposalVersion} 已作废，请重新调查后生成新草稿。`,
            });
            return { taskId, withdrawnVersion: input.proposalVersion, nextProposalVersion: next, cursor: store.event(taskId, 'proposal.withdrawn', { proposalVersion: input.proposalVersion, reason }) };
          });
        },
        async revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; retire?: string[]; containers?: Proposal['containers']; loops?: Proposal['loops']; requestId: string; taskId?: string }) {
          ensureOpen();
          const target = revisionTarget(store, taskId, input.taskId);
          return store.command(`supervisor:${target}`, input.requestId, { type: 'revise', target, baseVersion: input.baseVersion, reason: input.reason, nodes: input.nodes, retire: input.retire ?? [], containers: input.containers, loops: input.loops }, () => {
            const revised = applyRevision(store, target, { baseVersion: input.baseVersion, reason: input.reason, nodes: input.nodes, newInstanceBudget: defaultBudgetTokens, ...(input.retire ? { retire: input.retire } : {}), ...(input.containers ? { containers: input.containers } : {}), ...(input.loops ? { loops: input.loops } : {}) });
            return { taskId: target, graphVersion: revised.version, cursor: revised.cursor };
          });
        },
        async validateProposal(proposal: Proposal) {
          ensureOpen();
          const task = store.task(taskId);
          if (task.requirement_version !== proposal.requirementVersion) {
            throw new RuntimeError('stale_requirement', 'Proposal uses an old requirement version');
          }
          validateProposal(proposal);
          return { valid: true as const, requirementVersion: task.requirement_version };
        },
        async graphState() {
          ensureOpen();
          const task = store.task(taskId);
          const conversation = conversationForTask(store, taskId);
          const relatedTasks = conversation
            ? await Promise.all(conversationTaskIds(store, conversation.id)
              .filter(id => id !== taskId)
              .map(async id => {
                const view = await user.task(id).view();
                return {
                  taskId: view.id,
                  request: view.request,
                  phase: view.phase,
                  status: view.status,
                  paused: view.paused,
                  requirementVersion: view.requirementVersion,
                  proposalVersion: view.proposalVersion,
                  acceptedProposalVersion: view.acceptedProposalVersion,
                  graphVersion: view.graphVersion,
                  targetBranch: view.targetBranch,
                  integrationSha: view.integrationSha,
                  proposal: view.proposal,
                  containers: view.containers,
                  loops: view.loops,
                  nodes: view.nodes,
                  evidence: view.evidence,
                  questions: view.questions,
                  worktrees: view.worktrees,
                  cost: view.cost,
                };
              }))
            : [];
          const nodes = store.db.prepare(`SELECT n.id,n.spec,n.instance_id,n.status,n.activation_id,n.output_version,n.stall_count,
              i.used,i.budget,i.unlimited,i.model,i.definition_version
            FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id
            WHERE n.task_id=? ORDER BY n.rowid`).all(taskId) as {
              id: string; spec: string; instance_id: string | null; status: string; activation_id: string;
              output_version: number; stall_count: number; used: number | null; budget: number | null;
              unlimited: number | null; model: string | null; definition_version: string | null;
            }[];
          const questions = store.db.prepare('SELECT id,node_id,kind,status,owner,data,answer FROM questions WHERE task_id=? ORDER BY rowid').all(taskId) as {
            id: string; node_id: string; kind: string; status: string; owner: string; data: string; answer: string | null;
          }[];
          const openUserQuestions = questions.filter(question => question.owner === 'user' && question.status === 'open');
          const evidence = store.db.prepare('SELECT node_id,operation_id,proposal_version,requirement_version,data,activation_id,valid,commit_sha FROM evidence WHERE task_id=? ORDER BY rowid').all(taskId) as {
            node_id: string; operation_id: string; proposal_version: number; requirement_version: number; data: string;
            activation_id: string; valid: number; commit_sha: string | null;
          }[];
          const proposal = store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(taskId, task.latest_proposal) as { spec: string } | undefined;
          const graphRevision = task.graph_version
            ? store.db.prepare('SELECT spec FROM graph_revisions WHERE task_id=? AND version=?').get(taskId, task.graph_version) as { spec: string } | undefined
            : undefined;
          const graph = task.accepted_proposal ? loadGraph(store, taskId) : undefined;
          return {
            taskId,
            conversationId: task.conversation_id,
            projectId: task.project_id,
            request: task.request,
            phase: task.phase,
            status: task.paused ? 'paused' : openUserQuestions.length ? 'blocked' : task.phase,
            paused: Boolean(task.paused),
            requirementVersion: task.requirement_version,
            proposalVersion: task.latest_proposal,
            acceptedProposalVersion: task.accepted_proposal,
            graphVersion: task.graph_version,
            targetBranch: task.target_branch,
            integrationSha: task.integration_sha,
            updatedAt: (store.db.prepare('SELECT MAX(timestamp) AS updatedAt FROM events WHERE task_id=?').get(taskId) as { updatedAt: number | null }).updatedAt,
            cursor: (store.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events WHERE task_id=?').get(taskId) as { cursor: number }).cursor,
            proposal: proposal ? JSON.parse(proposal.spec) as Proposal : null,
            graph: graphRevision ? JSON.parse(graphRevision.spec) as Proposal : null,
            containers: graph ? graph.containers() : [],
            loops: graph ? graph.plan.loops : [],
            revisions: (store.db.prepare('SELECT version,reason,base_version FROM graph_revisions WHERE task_id=? ORDER BY version').all(taskId) as {
              version: number; reason: string; base_version: number;
            }[]).map(row => ({ version: row.version, reason: row.reason, baseVersion: row.base_version })),
            nodes: nodes.map(row => ({
              ...JSON.parse(row.spec) as NodeSpec,
              instanceId: row.instance_id,
              activationId: row.activation_id,
              outputVersion: row.output_version,
              stallCount: row.stall_count,
              status: row.status,
              used: row.used,
              unlimited: Boolean(row.unlimited),
              budget: row.unlimited ? null : row.budget,
              ...(row.model ? { selectedModel: row.model } : {}),
              ...(row.definition_version ? { boundDefinition: row.definition_version } : {}),
            })),
            evidence: evidence.map(row => ({
              ...JSON.parse(row.data) as EvidenceInput,
              nodeId: row.node_id,
              operationId: row.operation_id,
              proposalVersion: row.proposal_version,
              requirementVersion: row.requirement_version,
              activationId: row.activation_id,
              valid: Boolean(row.valid),
              ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
            })),
            questions: questions.map(row => ({
              id: row.id,
              nodeId: row.node_id,
              kind: row.kind,
              status: row.status,
              owner: row.owner,
              data: JSON.parse(row.data) as Json,
              answer: row.answer ? JSON.parse(row.answer) as Json : null,
            })),
            internalProblemCount: questions.filter(question => question.owner === 'main' && question.status === 'open').length,
            worktrees: (store.db.prepare('SELECT instance_id,node_id,path,branch FROM worktrees WHERE task_id=? ORDER BY rowid').all(taskId) as {
              instance_id: string; node_id: string; path: string; branch: string;
            }[]).map(row => ({ instanceId: row.instance_id, nodeId: row.node_id, path: row.path, branch: row.branch })),
            cost: taskCost(taskId),
            relatedTasks,
          };
        },
        async taskStatus(input: { taskId?: string; nodeId?: string; waitForNode?: string; timeoutMs?: number }) {
          ensureOpen();
          const target = conversationTarget(store, taskId, input.taskId, 'A status query');
          const nodeId = input.nodeId === undefined ? undefined : String(input.nodeId);
          const first = taskStatusView(store, target, nodeId);
          const waiting = input.waitForNode === undefined ? undefined : String(input.waitForNode);
          if (!waiting) return first;
          const timeout = Math.max(0, Math.min(600_000, Math.trunc(input.timeoutMs ?? 120_000)));
          const started = Date.now();
          const known = new Set([...first.questions, ...first.problems].map(entry => entry.id));
          let current = first;
          let reason: 'settled' | 'needs_you' | 'timeout' = 'timeout';
          for (;;) {
            const node = current.nodes.find(entry => entry.id === waiting);
            if (!node) throw new RuntimeError('not_found', `Task ${target} has no node ${waiting}`);
            if ([...current.questions, ...current.problems].some(entry => !known.has(entry.id))) { reason = 'needs_you'; break; }
            if (node.status !== 'pending' && node.status !== 'running') { reason = 'settled'; break; }
            if (Date.now() - started >= timeout) { reason = 'timeout'; break; }
            await new Promise(resolve => setTimeout(resolve, 1_000));
            current = taskStatusView(store, target, nodeId);
          }
          return { ...current, waitedMs: Date.now() - started, reason };
        },
        async listProjects() {
          ensureOpen();
          return user.projects();
        },
        async bindProject(input: { projectId: string; requestId: string }) {
          ensureOpen();
          const conversation = conversationForTask(store, taskId);
          if (!conversation) throw new RuntimeError('not_found', 'This Main Agent is not attached to a conversation');
          return conversations.bind(conversation.id, input);
        },
        async listProblems() {
          ensureOpen();
          const conversation = conversationForTask(store, taskId);
          if (!conversation) return [];
          const tasks = conversationTaskIds(store, conversation.id);
          const placeholders = tasks.map(() => '?').join(',');
          return (store.db.prepare(`SELECT q.id,q.task_id,q.node_id,q.kind,q.data,
              t.request,t.phase,n.status AS node_status,i.model
            FROM questions q JOIN tasks t ON t.id=q.task_id
            LEFT JOIN nodes n ON n.task_id=q.task_id AND n.id=q.node_id
            LEFT JOIN instances i ON i.id=n.instance_id
            WHERE q.owner='main' AND q.status='open' AND q.task_id IN (${placeholders})
            ORDER BY q.rowid`).all(...tasks) as {
              id: string; task_id: string; node_id: string; kind: string; data: string;
              request: string; phase: string; node_status: string | null; model: string | null;
            }[]).map(row => {
              const data = JSON.parse(row.data) as Json;
              return {
                id: row.id,
                taskId: row.task_id,
                nodeId: row.node_id,
                kind: row.kind,
                summary: questionSummary(row.kind, data),
                data,
                taskRequest: row.request,
                taskPhase: row.phase,
                nodeStatus: row.node_status,
                model: row.model,
                allowedActions: problemActions(row.kind),
              };
            });
        },
        async pendingHumanChecks() {
          ensureOpen();
          const conversation = conversationForTask(store, taskId);
          if (!conversation) return [];
          return pendingHumanChecks(store, conversation.id).map(check => ({
            ...check,
            evidence: humanCheckPreReview(store, check.questionId),
          }));
        },
        async reviewHumanCheck(input: { questionId: string; approve: boolean; note: string; requestId: string }) {
          ensureOpen();
          const conversation = conversationForTask(store, taskId);
          if (!conversation) throw new RuntimeError('not_found', 'This master is not attached to a conversation');
          // The check may belong to any graph task of this conversation, so scope by
          // conversation rather than by the anchor task the master itself runs on.
          const inConversation = pendingHumanChecks(store, conversation.id).some(check => check.questionId === input.questionId);
          if (!inConversation) {
            throw new RuntimeError('not_found', 'No open human acceptance check with that id in this conversation');
          }
          return store.command(`human-review:${taskId}`, input.requestId, input, () => {
            if (input.approve) {
              return { questionId: input.questionId, approved: approveHumanCheck(store, input.questionId, input.note) };
            }
            // Sending it back is rework, which already means "returned for the main Agent to
            // fix" and already reaches the node's own turn. Reusing it keeps one way to say
            // "this is not acceptable" instead of inventing a second.
            const check = humanCheckPreReview(store, input.questionId);
            if (!check || check.status !== 'open') {
              throw new RuntimeError('not_found', 'That human acceptance check is not open');
            }
            insertQuestion(store, {
              taskId: check.taskId,
              nodeId: check.nodeId,
              kind: 'rework',
              data: {
                prompt: 'The main Agent reviewed the human acceptance check and sent it back',
                reason: input.note,
                rejected: true,
              },
            });
            store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?")
              .run(canonicalJson({ type: 'reject', reason: input.note }), input.questionId);
            return { questionId: input.questionId, approved: false, sentBack: true };
          });
        },
        async resolveProblem(input: {
          questionId: string;
          action: 'retry' | 'acknowledge' | 'respond' | 'reconcile_usage' | 'escalate';
          response?: string;
          proof?: string;
          requestId: string;
        }) {
          ensureOpen();
          const conversation = conversationForTask(store, taskId);
          if (!conversation) throw new RuntimeError('not_found', 'This master is not attached to a conversation');
          const scopedTasks = conversationTaskIds(store, conversation.id);
          const receipt = store.command(`problems:${taskId}`, input.requestId, input, () => {
            const placeholders = scopedTasks.map(() => '?').join(',');
            const row = store.db.prepare(`SELECT id,task_id,node_id,kind,data
              FROM questions WHERE id=? AND owner='main' AND status='open' AND task_id IN (${placeholders})`)
              .get(input.questionId, ...scopedTasks) as { id: string; task_id: string; node_id: string; kind: string; data: string } | undefined;
            if (!row) {
              // A problem that was already settled is not an error: answering it twice must be safe
              // (a receipt the main Agent never saw), and "already resolved" must stay
              // distinguishable from "no such problem".
              const settled = store.db.prepare(`SELECT id,task_id,answer FROM questions
                WHERE id=? AND owner='main' AND status='resolved' AND task_id IN (${placeholders})`)
                .get(input.questionId, ...scopedTasks) as { id: string; task_id: string; answer: string | null } | undefined;
              if (!settled) throw new RuntimeError('not_found', 'No open main-Agent problem with that id');
              return {
                questionId: settled.id, taskId: settled.task_id, action: input.action,
                resolved: true as const, alreadyResolved: true as const, answer: settled.answer,
              };
            }
            const allowed = problemActions(row.kind) as readonly string[];
            if (!allowed.includes(input.action)) {
              throw new RuntimeError('invalid_answer', `Problem ${row.kind} does not accept ${input.action}`);
            }
            if (input.action === 'escalate') {
              // The main Agent cannot judge this gap itself, so it hands the
              // decision to the user with its own explanation attached.
              if (!input.response?.trim()) throw new RuntimeError('invalid_answer', 'An explanation is required to escalate a problem to the user');
              execution.escalate(row.task_id, row.id, input.response.trim().slice(0, 4_000));
              return { questionId: row.id, taskId: row.task_id, action: input.action, resolved: true as const };
            }
            let answer: Answer;
            if (input.action === 'retry') answer = { type: 'retry' };
            else if (input.action === 'acknowledge') answer = { type: 'acknowledge' };
            else if (input.action === 'respond') {
              if (!input.response?.trim()) throw new RuntimeError('invalid_answer', 'A response is required');
              answer = { type: 'respond', value: input.response.trim().slice(0, 4_000) };
            } else {
              if (!input.proof?.trim()) throw new RuntimeError('invalid_answer', 'A reconciliation rationale is required');
              answer = { type: 'reconcile_usage', proof: input.proof.trim().slice(0, 4_000) };
            }
            execution.answer(row.task_id, row.id, answer);
            store.event(row.task_id, 'problem.resolved', {
              questionId: row.id,
              nodeId: row.node_id,
              kind: row.kind,
              action: input.action,
            });
            return { questionId: row.id, taskId: row.task_id, action: input.action, resolved: true as const };
          });
          if (options.autoWake) execution.kick();
          return receipt;
        },
      };
    },
    events(taskId: string, after = 0, limit = 200) {
      ensureOpen(); store.task(taskId);
      const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
      return (store.db.prepare('SELECT cursor,type,data,timestamp FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT ?').all(taskId, after, cap) as { cursor: number; type: string; data: string; timestamp: number }[])
        .map(row => ({ cursor: row.cursor, type: row.type, data: JSON.parse(row.data) as Json, timestamp: row.timestamp, taskId }));
    },
    operations(taskId: string, query: import('./operation-lifecycle.ts').OperationQuery = {}) {
      ensureOpen(); store.task(taskId);
      const limit = Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 100) : 50;
      const rows = operationSnapshots(store, taskId, { ...query, limit });
      return rows.map(row => {
        const start = row.dispatchedAt;
        const stop = row.settledAt;
        return {
          ...row.operation, state: row.state, reserved: row.reserved, workerActive: row.workerActive,
          result: row.result,
          ...(start ? { startedAt: start } : {}), ...(stop ? { endedAt: stop, durationMs: stop - (start ?? stop) } : {}),
        };
      });
    },
    models() {
      ensureOpen();
      // Settings must reflect the models configured right now. The `models`
      // table is append-only history for old task records, so reading it here
      // would keep offering models the user already removed. Each entry carries
      // the thinking strengths that model accepts, so no console control has to
      // keep a level list of its own.
      return liveEntries().map(entry => ({ ...entry, thinkingOptions: thinkingOptionsFor(entry) }));
    },
    /** The model a new conversation would use before any per-chat override. */
    defaultModel() {
      ensureOpen();
      return masterModel() ?? null;
    },
    catalog: {
      publishDefinition(id: string, spec: DefinitionSpec, requestId: string) {
        ensureOpen();
        return store.command('catalog', requestId, { type: 'publish', id, spec }, () => catalog.publishDefinition(id, spec));
      },
      ensureDefinition(id: string, spec: DefinitionSpec) {
        ensureOpen();
        return catalog.ensureDefinition(id, spec);
      },
      definitions() { ensureOpen(); return catalog.listDefinitions(); },
      availableAgentDefinitions() { ensureOpen(); return catalog.availableAgentDefinitions(); },
      capabilities() { ensureOpen(); return catalog.capabilities(); },
      capabilitiesView() { ensureOpen(); return catalog.capabilitiesView(); },
      capability(id: string, version?: string) { ensureOpen(); return catalog.capability(id, version); },
      capabilityRootPath() { ensureOpen(); return catalog.capabilityRootPath(); },
      agentCombinationFilePath() { ensureOpen(); return catalog.agentCombinationFilePath(); },
      agentCombinationError() { ensureOpen(); return catalog.agentCombinationError(); },
      agentCombinations() { ensureOpen(); return catalog.agentCombinations(); },
      async saveAgentCombination(input: import('../catalog/agent-combinations.ts').AgentCombination) {
        ensureOpen();
        return catalog.saveAgentCombination(input);
      },
      async updateAgentCombinationDescription(id: string, description: string) {
        ensureOpen();
        return catalog.updateAgentCombinationDescription(id, description);
      },
      async deleteAgentCombination(id: string) {
        ensureOpen();
        return catalog.deleteAgentCombination(id);
      },
      compileAgentCombination(id: string) {
        ensureOpen();
        return catalog.compileAgentCombination(id);
      },
      async refreshCatalog() {
        ensureOpen();
        await catalog.refresh();
        return { capabilities: catalog.capabilities(), agentCombinations: catalog.agentCombinations() };
      },
      /** Pi extension sources that have a newer version than the one on disk. */
      async piExtensionUpdates() {
        ensureOpen();
        const updates: PiExtensionUpdate[] = [];
        for (const record of catalog.capabilities()) {
          const source = record.kind === 'pi-extension' && record.status === 'available' ? record.packageSource : undefined;
          if (!source) continue;
          const base = { id: record.id, version: record.version, source };
          try {
            updates.push({ ...base, ...await piExtensionSourceStatus({ source, cwd: stateDir, agentDir: piExtensionCacheDir(catalog) }) });
          } catch (error) {
            updates.push({ ...base, installed: null, latest: null, available: false, installGaps: [], error: error instanceof Error ? error.message : String(error) });
          }
        }
        return { updates };
      },
      /** Install or upgrade one Pi extension source, then rescan the capability library. */
      async updatePiExtension(id: string, version: string) {
        ensureOpen();
        const record = catalog.capability(id, version);
        if (!record?.packageSource) throw new RuntimeError('not_found', `Pi extension ${id}@${version} has no package source`);
        const result = await updatePiExtensionSource({ source: record.packageSource, cwd: stateDir, agentDir: piExtensionCacheDir(catalog) });
        await syncCapabilityVersion(record.source, result.version);
        await catalog.refresh();
        return result;
      },
      preset(id: string) { ensureOpen(); return catalog.preset(id); },
      definitionSpec(id: string, version: number) { ensureOpen(); return catalog.definition(`${id}@${version}`); },
      recordPreset(id: string, version: string, hash: string, detail: Json) { ensureOpen(); return catalog.recordPreset(id, version, hash, detail); },
    },
    /** Durable tool-call telemetry: calls, failures and durations per tool and Agent role. */
    toolCallStats() {
      ensureOpen();
      // Worker lanes spool their calls; reading the numbers is when they join the record.
      return ingestToolCallSpools(store, stateDir).then(() => ({
        generatedAt: Date.now(),
        retentionDays: TaskStore.TOOL_CALL_RETENTION_DAYS,
        stats: store.toolCallStats(),
      }));
    },
    /** Which skills exist for the known projects and the main Agent, and which were read. */
    skillStats() {
      ensureOpen();
      // Worker lanes spool their calls; reading the numbers is when they join the record.
      return ingestToolCallSpools(store, stateDir).then(() => {
        const roots = (configuredProjects() ?? []).map(project => project.root).filter(root => typeof root === 'string' && root.trim().length > 0);
        const main = catalog.listDefinitions().find(item => item.id === 'main');
        const capabilityRoot = options.catalog?.capabilityRoot;
        return {
          generatedAt: Date.now(),
          retentionDays: TaskStore.TOOL_CALL_RETENTION_DAYS,
          ...skillUsage({
            store,
            ...(roots.length ? { projectRoots: roots } : {}),
            ...(main && capabilityRoot ? { agentSkillsDir: agentSkillsDir(main.id, resolve(capabilityRoot, '..')) } : {}),
            ...(capabilityRoot ? { capabilityRoot } : {}),
          }),
        };
      });
    },
    /** Promote one project skill into the capability library; binding stays the user's decision. */
    promoteSkill(skillId: string) {
      ensureOpen();
      const capabilityRoot = options.catalog?.capabilityRoot;
      if (!capabilityRoot) throw new RuntimeError('invalid_config', 'Capability library is unavailable');
      const roots = (configuredProjects() ?? [])
        .map(project => project.root)
        .filter(root => typeof root === 'string' && root.trim().length > 0)
        .map(root => resolve(root));
      return promoteSkillFromProjects({ projectRoots: roots, skillId, capabilityRoot });
    },
    /** Drop the recorded tool calls, so a stale sample cannot be read as a fresh one. */
    clearToolCalls() {
      ensureOpen();
      const removed = store.clearToolCalls();
      store.forgetToolCallSpools();
      return clearToolCallSpools(stateDir).then(() => ({ removed }));
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => { await execution.drain(); try { store.close(); } finally { releaseOwner(); } })();
      }
      return closing;
    },
  };
  channels.supervisor = runtime.supervisor;
  return runtime;
}
