import { randomUUID } from 'node:crypto';
import { closePause, closeUserWait, openPause } from './time-ledger.ts';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TaskStore, canonicalJson } from './store.ts';
import { appendMessage, conversationForTask, conversationRow, deliverMessages, listMessages, pendingMessages, type MessageRow } from './conversation.ts';
import { Execution } from './execution.ts';
import { contextView } from './context.ts';
import { setBudget } from './budget-ledger.ts';
import { acquireOwner } from './owner.ts';
import { validateProposal } from './proposal.ts';
import { createActivation, hasLockedQuestion, loadGraph } from './graph.ts';
import { applyRevision } from './revision.ts';
import { nodeRun as nodeRunView } from './node-run.ts';
import { operationSnapshots } from './operation-lifecycle.ts';
import { talentDetail, talentExperience } from './talent.ts';
import { Catalog, type DefinitionSpec } from '../catalog/catalog.ts';
import { mergeCosts, sumCosts, type ModelEntry } from '../catalog/models.ts';
import { createPiAdapter, type PiAdapterChannels } from '../runtime/pi-adapter.ts';
import { GitIntegration } from '../git/integration.ts';
import { invocationRows } from '../runtime/task-gate.ts';
import { createModelScheduler, type ModelScheduler } from '../runtime/model-scheduler.ts';
import type { ActionAdapter, Answer, EvidenceInput, Json, Operation, OperationResult } from './types.ts';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RuntimeError, type AttachmentInput, type ProjectConfig, type Proposal, type ProposalReceipt, type Receipt, type NodeSpec, type TaskUpdate, type TaskWatch } from './types.ts';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function asThinkingLevel(value: string): ThinkingLevel {
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new RuntimeError('invalid_input', 'A valid thinking level is required');
  return value as ThinkingLevel;
}

function cleanAttachments(input: AttachmentInput[] | undefined) {
  const attachments = input ?? [];
  if (attachments.length > 5) throw new RuntimeError('invalid_input', 'A message can contain at most five attachments');
  let totalBytes = 0;
  return attachments.map(attachment => {
    if (!attachment || typeof attachment.name !== 'string' || !attachment.name.trim() || attachment.name.length > 240) {
      throw new RuntimeError('invalid_input', 'Attachment names must be nonempty and bounded');
    }
    if (typeof attachment.type !== 'string' || attachment.type.length > 160 || typeof attachment.text !== 'string') {
      throw new RuntimeError('invalid_input', 'Attachment type and text are required');
    }
    const bytes = Buffer.byteLength(attachment.text, 'utf8');
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > 262_144 || bytes > 262_144) {
      throw new RuntimeError('invalid_input', `Attachment ${attachment.name} exceeds the 256 KiB text limit`);
    }
    totalBytes += bytes;
    if (totalBytes > 524_288) throw new RuntimeError('invalid_input', 'Combined text attachments exceed 512 KiB');
    if (attachment.text.includes('\0')) throw new RuntimeError('invalid_input', `Attachment ${attachment.name} is not a text file`);
    return { name: attachment.name.trim(), type: attachment.type, size: attachment.size, text: attachment.text };
  });
}

function steeringText(row: MessageRow) {
  const parts = row.text.trim() ? [row.text.trim()] : [];
  if (row.data) {
    try {
      const data = JSON.parse(row.data) as { attachments?: unknown };
      if (Array.isArray(data.attachments)) {
        for (const value of data.attachments) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const attachment = value as { name?: unknown; text?: unknown };
          if (typeof attachment.name === 'string' && typeof attachment.text === 'string') {
            parts.push(`附件 ${attachment.name}:\n${attachment.text}`);
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
  /** Hot-reloadable configuration view. When present, entries, preferences,
   * credential bindings, master model, projects and default budget are read
   * per use instead of from the static options captured at startup. */
  live?: {
    revision(): number;
    entries(): ModelEntry[];
    preferences(): Partial<Record<ModelEntry['grade'], string[]>>;
    credentialFor(entry: ModelEntry): { credentialId: string; apiKey: string; limit?: number; sharedGroupId?: string; groupLimit?: number } | undefined;
    masterModel(): string | undefined;
    defaultBudgetTokens(): number | null;
    projects?(): ProjectConfig[];
  };
  /** Host-selected grants and environment for confirmed program checks only. */
  program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string };
  /** Read-only host inventory exposed to the master Agent. It must never
   * contain secret values or write configuration on the Agent's behalf. */
  systemContext?: {
    systemSummary?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  };
  /** User-owned capability and recipe files. The desktop daemon passes ~/.graph. */
  catalog?: {
    capabilityRoot?: string;
    recipesPath?: string;
    bootstrapPrompts?: Record<string, string>;
    bootstrapToolPrompt?: string;
  };
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
  const liveEntries = () => options.live?.entries() ?? options.models?.entries ?? [];
  const livePreferences = (): Partial<Record<ModelEntry['grade'], string[]>> | undefined =>
    options.live ? options.live.preferences() : options.models?.preferences;
  // `null` is the legitimate unlimited default: it must never fall back to a
  // stale finite startup value when live configuration is present.
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
  const recoverMasterNodes = () => {
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
    });
    await catalog.refresh();
    git = new GitIntegration(store, stateDir);
    const slotScheduler: ModelScheduler = options.models?.modelScheduler ? options.models.modelScheduler : createModelScheduler();
    if (options.models) {
      store.transaction(() => {
        for (const entry of options.models!.entries) store.db.prepare('INSERT OR REPLACE INTO models VALUES(?,?)').run(entry.id, canonicalJson(entry));
      });
    }
    const fallback = options.models || options.live ? createPiAdapter({
      store, instancesDir: join(stateDir, 'instances'), catalog, directory: liveEntries,
      apiKey: options.models?.apiKey ?? '', modelRuntime: options.models!.modelRuntime,
      ...(options.models?.credentialFor ? { bindingFor: (entry: ModelEntry) => options.models!.credentialFor!(entry) } : {}),
      ...(options.live ? { bindingFor: (entry: ModelEntry) => options.live!.credentialFor(entry) } : {}),
      scheduler: modelScheduler,
      ...(options.network ? { network: options.network } : {}),
      ...(options.capabilitySecrets ? { capabilitySecrets: options.capabilitySecrets } : {}),
      channels: {
        supervisor: taskId => channels.supervisor!(taskId),
        catalog,
        ...(options.catalog?.bootstrapPrompts ? { bootstrapPrompts: options.catalog.bootstrapPrompts } : {}),
        ...(options.catalog?.bootstrapToolPrompt ? { bootstrapToolPrompt: options.catalog.bootstrapToolPrompt } : {}),
        ...(options.systemContext ? { systemContext: options.systemContext } : {}),
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
      scratchRoot: stateDir,
      ...(options.models || options.live ? { models: liveEntries } : {}),
      ...(options.live || options.models?.preferences ? { preferences: options.live ? livePreferences : options.models!.preferences } : {}),
      ...(options.program ? { program: options.program } : {}),
      ...(options.systemContext ? {
        systemContext: {
          resources: true,
          agentCombinations: true,
          systemSummary: Boolean(options.systemContext.systemSummary),
          requestModelAccess: true,
        },
      } : {}),
      autoWake: Boolean(options.autoWake),
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
      const setPaused = (paused: boolean, requestId: string): Receipt => {
        ensureOpen();
        return store.command('user', requestId, { type: paused ? 'pause' : 'resume', taskId }, () => {
          store.db.prepare('UPDATE tasks SET paused=? WHERE id=?').run(Number(paused), taskId);
          // Pause/resume are explicit state boundaries: accumulate the ledger
          // here instead of inferring durations from event or message times.
          if (paused) openPause(store, taskId);
          else closePause(store, taskId);
          return { taskId, cursor: store.event(taskId, paused ? 'task.pause_requested' : 'task.resumed', {}) };
        });
      };
      return {
        async pause(requestId: string) { return setPaused(true, requestId); },
        async resume(requestId: string) { return setPaused(false, requestId); },
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
          const operations = operationSnapshots(store, taskId);
          const questions = store.db.prepare('SELECT * FROM questions WHERE task_id=? ORDER BY rowid').all(taskId) as { id: string; node_id: string; operation_id: string | null; kind: string; status: string; data: string; answer: string | null }[];
          const proposal = store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(taskId, task.latest_proposal) as { spec: string } | undefined;
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
              const graph = task.accepted_proposal ? loadGraph(store, taskId) : undefined;
              return { containers: graph ? graph.containers() : [], loops: graph ? graph.plan.loops : [] };
            })(),
            revisions: (store.db.prepare('SELECT version,reason,base_version FROM graph_revisions WHERE task_id=? ORDER BY version').all(taskId) as { version: number; reason: string; base_version: number }[]),
            targetBranch: task.target_branch, phase: task.phase, paused: Boolean(task.paused),
            updatedAt: (store.db.prepare('SELECT MAX(timestamp) AS updatedAt FROM events WHERE task_id=?').get(taskId) as { updatedAt: number | null }).updatedAt,
            status: task.paused ? (operations.some(op => op.workerActive) ? 'pausing' : 'paused') : questions.some(q => q.status === 'open') ? 'blocked' : task.phase,
            operations: operations.map(row => ({ ...row.operation, state: row.state, reserved: row.reserved, workerActive: row.workerActive, result: row.result })),
            questions: questions.map(row => ({ id: row.id, nodeId: row.node_id, operationId: row.operation_id, kind: row.kind, status: row.status, data: JSON.parse(row.data) as Json, answer: row.answer ? JSON.parse(row.answer) as Json : null })),
            worktrees: (store.db.prepare('SELECT instance_id,node_id,path,branch FROM worktrees WHERE task_id=?').all(taskId) as { instance_id: string; node_id: string; path: string; branch: string }[])
              .map(row => ({ instanceId: row.instance_id, nodeId: row.node_id, path: row.path, branch: row.branch })),
            integrationSha: task.integration_sha,
            nodes: rows.map(row => ({ ...JSON.parse(row.spec) as NodeSpec, instanceId: row.instance_id, activationId: row.activation_id, outputVersion: row.output_version, stallCount: row.stall_count, status: row.status, used: row.used, unlimited: Boolean(row.unlimited), budget: row.unlimited ? null : row.budget,
              ...(row.model ? { selectedModel: row.model } : {}), ...(row.definition_version ? { boundDefinition: row.definition_version } : {}),
              reserved: operations.filter(op => op.operation.nodeId === row.id).reduce((sum, op) => sum + op.reserved, 0) })),
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
        (SELECT MAX(timestamp) FROM events WHERE task_id=t.id) AS updatedAt,
        (SELECT COUNT(*) FROM questions WHERE task_id=t.id AND status='open') AS openQuestions
        FROM tasks t WHERE t.phase!='chatting' ORDER BY t.created_seq`).all() as { id: string; projectId: string; request: string; phase: string; paused: number; acceptedProposalVersion: number | null; conversationId: string | null; updatedAt: number | null; openQuestions: number }[];
      return rows.map(row => ({
        id: row.id, projectId: row.projectId, request: row.request, phase: row.phase, conversationId: row.conversationId,
        status: row.paused ? 'paused' : row.openQuestions > 0 ? 'blocked' : row.phase,
        acceptedProposalVersion: row.acceptedProposalVersion, updatedAt: row.updatedAt, openQuestions: row.openQuestions,
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
    async create(input: { projectId?: string; title?: string; text?: string; attachments?: AttachmentInput[]; requestId: string }) {
      ensureOpen();
      const conversationId = randomUUID();
      if (!input.projectId) await mkdir(join(stateDir, 'conversations', conversationId), { recursive: true, mode: 0o700 });
      const attachments = cleanAttachments(input.attachments);
      return store.command('conversations', input.requestId, { type: 'create', projectId: input.projectId ?? null, title: input.title ?? null, text: input.text ?? null, attachments }, () => {
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
          const masterEntry = liveEntries().find(model => model.id === masterModel());
          if (masterEntry?.defaultThinkingLevel) {
            store.db.prepare('UPDATE conversations SET thinking_level=? WHERE id=?').run(masterEntry.defaultThinkingLevel, conversationId);
          }
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
        (SELECT COUNT(*) FROM questions q JOIN tasks t ON t.id=q.task_id WHERE t.conversation_id=c.id AND q.status='open') AS openQuestions,
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
        const thinkingLevel = entry.reasoning === false ? 'off' : requestedThinking;
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
      const master = store.db.prepare("SELECT n.status,i.id AS instance_id,i.used,i.budget,i.unlimited,i.model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'").get(conversation.anchor_task_id) as { status: string; instance_id: string | null; used: number | null; budget: number | null; unlimited: number | null; model: string | null; definition_version: string | null } | undefined;
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
      const tasks = (store.db.prepare("SELECT id,request,phase,paused,target_branch,accepted_proposal,integration_sha FROM tasks WHERE conversation_id=? AND phase!='chatting' ORDER BY created_seq").all(conversationId) as { id: string; request: string; phase: string; paused: number; target_branch: string | null; accepted_proposal: number | null; integration_sha: string | null }[]).map(task => {
        const nodes = store.db.prepare('SELECT n.id,n.spec,n.status,n.stall_count,n.output_version,i.used,i.budget,i.unlimited,i.model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid').all(task.id) as { id: string; spec: string; status: string; stall_count: number; output_version: number; used: number | null; budget: number | null; unlimited: number | null; model: string | null; definition_version: string | null }[];
        const questions = store.db.prepare('SELECT id,node_id,kind,status,data FROM questions WHERE task_id=? ORDER BY rowid').all(task.id) as { id: string; node_id: string; kind: string; status: string; data: string }[];
        const open = questions.filter(question => question.status === 'open');
        const evidence = store.db.prepare('SELECT acceptance_id,valid FROM evidence WHERE task_id=? ORDER BY rowid').all(task.id) as { acceptance_id: string; valid: number }[];
        return {
          id: task.id, request: task.request, phase: task.phase, paused: Boolean(task.paused),
          status: task.paused ? 'paused' : open.length ? 'blocked' : task.phase,
          targetBranch: task.target_branch, acceptedProposalVersion: task.accepted_proposal, integrationSha: task.integration_sha,
          openQuestions: open.map(question => ({ id: question.id, nodeId: question.node_id, kind: question.kind, data: JSON.parse(question.data) as Json })),
          nodes: nodes.map(row => ({ id: row.id, kind: (JSON.parse(row.spec) as NodeSpec).kind, role: (JSON.parse(row.spec) as NodeSpec).role ?? null, status: row.status, used: row.used, unlimited: Boolean(row.unlimited), budget: row.unlimited ? null : row.budget, model: row.model, definitionVersion: row.definition_version, stallCount: row.stall_count, outputVersion: row.output_version })),
          cost: taskCost(task.id),
          evidence: evidence.map(item => ({ acceptanceId: item.acceptance_id, valid: Boolean(item.valid) })),
        };
      });
      const project = conversation.project_id ? store.db.prepare('SELECT root FROM projects WHERE id=?').get(conversation.project_id) as { root: string } | undefined : undefined;
      const anchorQuestions = (store.db.prepare('SELECT id,node_id,operation_id,kind,status,data,answer FROM questions WHERE task_id=? ORDER BY rowid').all(conversation.anchor_task_id) as { id: string; node_id: string; operation_id: string | null; kind: string; status: string; data: string; answer: string | null }[])
        .map(question => ({ id: question.id, nodeId: question.node_id, operationId: question.operation_id, kind: question.kind, status: question.status, data: JSON.parse(question.data) as Json, answer: question.answer ? JSON.parse(question.answer) as Json : null, taskId: conversation.anchor_task_id }));
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
      const masterInvocations = master?.instance_id
        ? (store.db.prepare('SELECT usage,purpose FROM invocations WHERE instance_id=? ORDER BY rowid').all(master.instance_id) as { usage: string | null; purpose: string }[])
        : [];
      const knownMasterUsage = masterInvocations
        .map(invocation => invocation.usage ? JSON.parse(invocation.usage) as { input: number; output: number; cacheRead: number; cacheWrite: number } : null)
        .filter((usage): usage is { input: number; output: number; cacheRead: number; cacheWrite: number } => usage !== null);
      const cacheInput = knownMasterUsage.reduce((sum, usage) => sum + usage.input + usage.cacheRead + usage.cacheWrite, 0);
      const cachedInput = knownMasterUsage.reduce((sum, usage) => sum + usage.cacheRead, 0);
      const latestCompletion = [...masterInvocations].reverse().find(invocation => invocation.purpose === 'completion' && invocation.usage !== null);
      const latestUsage = latestCompletion?.usage
        ? JSON.parse(latestCompletion.usage) as { input: number; cacheRead: number; cacheWrite: number }
        : null;
      const contextLimit = master?.model ? liveEntries().find(entry => entry.id === master.model)?.contextWindow ?? null : null;
      const contextTokens = latestUsage ? latestUsage.input + latestUsage.cacheRead + latestUsage.cacheWrite : null;
      return {
        id: conversation.id, title: conversation.title, projectId: conversation.project_id, projectRoot: project?.root ?? null,
        archived: conversation.archived_at !== null, archivedAt: conversation.archived_at,
        paused: Boolean(anchor.paused),
        workspaceProjectId: conversation.workspace_project_id, anchorTaskId: conversation.anchor_task_id,
        createdAt: conversation.created_at, requirementVersion: anchor.requirement_version,
        messages: listMessages(store, conversationId, query), messageCount,
        questions: anchorQuestions,
        proposal,
        proposalHistory,
        accepted: accepted.map(row => ({ proposalVersion: row.proposal_version, taskId: row.task_id, targetBranch: row.target_branch, acceptedAt: row.accepted_at })),
        master: master ? { nodeId: 'master', status: master.status, model: master.model, used: master.used, unlimited: Boolean(master.unlimited), budget: master.unlimited ? null : master.budget, definitionVersion: master.definition_version, cost: masterCost, questions: anchorQuestions.filter(question => question.status === 'open') } : null,
        telemetry: {
          model: master?.model ?? null,
          thinkingLevel: conversation.thinking_level,
          cacheHitRate: knownMasterUsage.length && cacheInput > 0 ? cachedInput / cacheInput : null,
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
    async chat(conversationId: string, input: { text: string; requestId: string; attachments?: AttachmentInput[] }) {
      ensureOpen();
      const conversation = conversationRow(store, conversationId);
      const attachments = cleanAttachments(input.attachments);
      const receipt = store.command(`conversation:${conversationId}`, input.requestId, { type: 'chat', text: input.text, attachments }, () => {
        if (!input.text.trim() && !attachments.length) throw new RuntimeError('invalid_input', 'A nonempty message or attachment is required');
        const node = store.db.prepare("SELECT status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'").get(conversation.anchor_task_id) as { status: string } | undefined;
        const anchor = store.task(conversation.anchor_task_id);
        const state = anchor.paused || (node && ['preparing', 'running', 'blocked'].includes(node.status)) ? 'queued' : 'pending';
        const message = appendMessage(store, {
          conversationId, role: 'user', kind: 'chat', text: input.text.trim(), state,
          ...(attachments.length ? { data: { attachments } as unknown as Json } : {}),
        });
        // A running turn picks the message up when it settles; a blocked one
        // waits for its open question; everything else queues a next turn now.
        if (node && !['preparing', 'running', 'blocked'].includes(node.status)) {
          store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id='master'").run(conversation.anchor_task_id);
        }
        return { conversationId, messageId: message.id, state, cursor: message.cursor, pending: state === 'queued' };
      });
      if (options.autoWake) execution.kick();
      return receipt;
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
      await execution.steer(active.id, combined);

      const receipt = store.transaction(() => {
        const ids = messages.map(message => message.id);
        deliverMessages(store, active.id, operation.attempt, messages);
        const cursor = store.event(conversation.anchor_task_id, 'message.steered', {
          operationId: active.id, messageIds: ids, requestId: input.requestId,
        });
        return { conversationId, state: 'steered' as const, steered: ids.length, cursor };
      });
      return receipt;
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
    async confirm(conversationId: string, input: { proposalVersion: number; targetBranch: string; requestId: string }) {
      ensureOpen();
      const bound = conversationRow(store, conversationId);
      if (!bound.project_id) throw new RuntimeError('invalid_input', 'Bind a project before confirming a draft');
      if (!input.targetBranch.trim()) throw new RuntimeError('invalid_input', 'A target branch is required');
      git.requireTargetBranch(bound.project_id, input.targetBranch);
      const receipt = store.command(`conversation:${conversationId}`, input.requestId, { type: 'confirm', proposalVersion: input.proposalVersion, targetBranch: input.targetBranch }, () => {
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
        store.db.prepare('INSERT INTO graph_revisions(task_id,version,spec,reason,base_version) VALUES(?,1,?,?,0)').run(taskId, row.spec, 'Confirmed conversation draft');
        for (const node of proposal.nodes) {
          const instanceId = node.kind === 'agent' ? randomUUID() : null;
          store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, node.id, canonicalJson(node), instanceId);
          if (instanceId) insertInstance(instanceId, taskId, node.id, node.definitionVersion ?? null, node.model ?? null);
          createActivation(store, taskId, node.id, 1);
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
    events(conversationId: string, after = 0, limit = 200) {
      ensureOpen();
      const ids = conversationTaskIds(store, conversationId);
      const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
      return (store.db.prepare(`SELECT cursor,task_id,type,data,timestamp FROM events WHERE task_id IN (${ids.map(() => '?').join(',')}) AND cursor>? ORDER BY cursor LIMIT ?`).all(...ids, after, cap) as { cursor: number; task_id: string; type: string; data: string; timestamp: number }[])
        .map(row => ({ cursor: row.cursor, type: row.type, data: JSON.parse(row.data) as Json, timestamp: row.timestamp, taskId: row.task_id }));
    },
  };

  const runtime = {
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
      return (store.db.prepare(`SELECT q.id,q.task_id AS taskId,q.node_id AS nodeId,q.kind,q.status,q.data,q.answer,
        t.request,t.project_id AS projectId,t.conversation_id AS conversationId
        FROM questions q JOIN tasks t ON t.id=q.task_id
        WHERE q.status='resolved'
        ORDER BY q.rowid DESC LIMIT ?`).all(cap) as {
        id: string; taskId: string; nodeId: string; kind: string; status: string; data: string; answer: string | null;
        request: string; projectId: string; conversationId: string | null;
      }[]).map(row => ({
        id: row.id, taskId: row.taskId, nodeId: row.nodeId, kind: row.kind, status: row.status,
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
    /** Read-only node detail: real session entries, operations and usage. */
    nodeRun(taskId: string, nodeId: string, query: { after?: number; before?: number; limit?: number } = {}) {
      ensureOpen();
      try {
        return nodeRunView(store, taskId, nodeId, query);
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== 'not_found') throw error;
        // A container has no instance of its own: summarize its children so the
        // graph view can drill into the group without a dead route.
        const graph = loadGraph(store, taskId);
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
    conversations,
    host: {
      async runReady() { ensureOpen(); return execution.runReady(); },
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
      async report(id: string, generation: number, result: OperationResult) { ensureOpen(); execution.report(id, generation, result); },
      async reconcile(id: string) { ensureOpen(); await execution.reconcile(id); },
      /** Create master nodes for pending tasks after a hot configuration apply. */
      recoverMasters() { ensureOpen(); return recoverMasterNodes(); },
    },
    supervisor(taskId: string) {
      ensureOpen(); store.task(taskId);
      // Give workers this scoped object, never the user or host runtime object.
      return {
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
              const rows = store.db.prepare("SELECT seq,text FROM messages WHERE conversation_id=? AND role='user' AND state='delivered' AND seq>? ORDER BY seq").all(conversation.id, since) as { seq: number; text: string }[];
              if (rows.length) snapshot = rows.map(row => `- [msg ${row.seq}] ${row.text.slice(0, 240)}`).join('\n');
            }
            store.db.prepare('INSERT INTO proposals(task_id,version,requirement_version,spec,decision_snapshot) VALUES(?,?,?,?,?)')
              .run(taskId, version, proposal.requirementVersion, canonicalJson(proposal), snapshot);
            store.db.prepare('UPDATE tasks SET latest_proposal=? WHERE id=?').run(version, taskId);
            return { taskId, proposalVersion: version, cursor: store.event(taskId, 'proposal.created', { proposalVersion: version }) };
          });
        },
        async revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; containers?: Proposal['containers']; loops?: Proposal['loops']; requestId: string }) {
          ensureOpen();
          return store.command(`supervisor:${taskId}`, input.requestId, { type: 'revise', baseVersion: input.baseVersion, reason: input.reason, nodes: input.nodes, containers: input.containers, loops: input.loops }, () => {
            const revised = applyRevision(store, taskId, { baseVersion: input.baseVersion, reason: input.reason, nodes: input.nodes, newInstanceBudget: defaultBudgetTokens, ...(input.containers ? { containers: input.containers } : {}), ...(input.loops ? { loops: input.loops } : {}) });
            return { taskId, graphVersion: revised.version, cursor: revised.cursor };
          });
        },
      };
    },
    events(taskId: string, after = 0, limit = 200) {
      ensureOpen(); store.task(taskId);
      const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
      return (store.db.prepare('SELECT cursor,type,data,timestamp FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT ?').all(taskId, after, cap) as { cursor: number; type: string; data: string; timestamp: number }[])
        .map(row => ({ cursor: row.cursor, type: row.type, data: JSON.parse(row.data) as Json, timestamp: row.timestamp, taskId }));
    },
    operations(taskId: string, query: { after?: string; limit?: number } = {}) {
      ensureOpen(); store.task(taskId);
      const limit = Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 100) : 50;
      const rows = operationSnapshots(store, taskId, { ...(query.after ? { after: query.after } : {}), limit });
      const ids = rows.map(row => row.id);
      const times = ids.length ? store.db.prepare(`SELECT type,data,timestamp FROM events WHERE task_id=? AND type IN ('operation.dispatched','operation.result') AND json_extract(data,'$.operationId') IN (${ids.map(() => '?').join(',')}) ORDER BY cursor`).all(taskId, ...ids) as { type: string; data: string; timestamp: number }[] : [];
      const started = new Map<string, number>();
      const ended = new Map<string, number>();
      for (const row of times) {
        const data = JSON.parse(row.data) as { operationId?: string };
        if (!data.operationId) continue;
        if (row.type === 'operation.dispatched') started.set(data.operationId, row.timestamp);
        if (row.type === 'operation.result') ended.set(data.operationId, row.timestamp);
      }
      return rows.map(row => {
        const start = started.get(row.id);
        const stop = ended.get(row.id);
        return {
          ...row.operation, state: row.state, reserved: row.reserved, workerActive: row.workerActive,
          result: row.result,
          ...(start ? { startedAt: start } : {}), ...(stop ? { endedAt: stop, durationMs: stop - (start ?? stop) } : {}),
        };
      });
    },
    models() {
      ensureOpen();
      return (store.db.prepare('SELECT id,spec FROM models ORDER BY id').all() as { id: string; spec: string }[])
        .map(row => ({ id: row.id, ...JSON.parse(row.spec) as { provider: string; grade: string } }));
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
      capabilities() { ensureOpen(); return catalog.capabilities(); },
      capability(id: string, version?: string) { ensureOpen(); return catalog.capability(id, version); },
      capabilityRootPath() { ensureOpen(); return catalog.capabilityRootPath(); },
      agentCombinationFilePath() { ensureOpen(); return catalog.agentCombinationFilePath(); },
      agentCombinationError() { ensureOpen(); return catalog.agentCombinationError(); },
      agentCombinations() { ensureOpen(); return catalog.agentCombinations(); },
      async saveAgentCombination(input: import('../catalog/agent-combinations.ts').AgentCombination) {
        ensureOpen();
        return catalog.saveAgentCombination(input);
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
      preset(id: string) { ensureOpen(); return catalog.preset(id); },
      definitionSpec(id: string, version: number) { ensureOpen(); return catalog.definition(`${id}@${version}`); },
      recordPreset(id: string, version: string, hash: string, detail: Json) { ensureOpen(); return catalog.recordPreset(id, version, hash, detail); },
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
