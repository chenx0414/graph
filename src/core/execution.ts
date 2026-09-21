import { isAbsolute } from 'node:path';
import { canonicalJson, type TaskStore } from './store.ts';
import { isFullAccess, resolveAccessPolicy, standardAccessPolicy, type ResolvedAccessPolicy } from './access-policy.ts';
import { assertWithinBudget, recordModelUse } from './budget-ledger.ts';
import { conversationDigest, conversationForTask, deliverMessages, pendingMessages } from './conversation.ts';
import { digest, freezeContextHandoff, handoffConstraintsDigest, resolveAgentContext } from './context.ts';
import { loadGraph } from './graph.ts';
import { independentReviewReady, implementerModels, isReviewer, pickModel } from './model-selection.ts';
import { graphVerifier, humanCheckNode, workspaceCommandNode } from './program-adapters.ts';
import { OperationLifecycle, type OperationIntent } from './operation-lifecycle.ts';
import { insertQuestion } from './question-routing.ts';
import { buildPredecessorHandoffs, nonCompliantResult, outputSchemaForNode, renderPredecessorHandoffs, renderResultHandoffRepair, requiresResultHandoff, resultHandoffRepair } from './predecessor-handoff.ts';
import { briefing } from '../catalog/briefing.ts';
import type { Catalog } from '../catalog/catalog.ts';
import type { ModelEntry } from '../catalog/models.ts';
import type { GitIntegration } from '../git/integration.ts';
import { executionLimit, occupiedSlots } from '../runtime/execution-slots.ts';
import { RuntimeError, type ActionAdapter, type Answer, type AttachmentInput, type ContextHandoffPackage, type Json, type NodeSpec, type Operation, type OperationResult, type Proposal } from './types.ts';

type ExecutionNodeRow = { id: string; task_id: string; spec: string; instance_id: string | null; status: string; output: string | null; activation_id: string };

/**
 * Settlement failures that describe a result the harness refuses to use, as
 * opposed to an external outcome nobody can observe. Those stay with the work
 * and become a repair problem instead of an uncertain operation.
 */
const SUBMISSION_DEFECT_CODES = new Set(['invalid_result', 'invalid_evidence']);

/** Private execution state machine. Every mutation shares the task command/event transaction. */
export class Execution {
  private readonly pending = new Set<Promise<unknown>>();
  private driveActive = 0;
  private stopping = false;
  private readonly driveWaiters: (() => void)[] = [];
  private readonly store: TaskStore;
  private readonly actions: Record<string, ActionAdapter>;
  private readonly fallback?: ActionAdapter;
  private readonly catalog?: Catalog;
  private readonly models?: () => ModelEntry[];
  private readonly preferences?: Partial<Record<ModelEntry['grade'], string[]>> | (() => Partial<Record<ModelEntry['grade'], string[]>> | undefined);
  private readonly git?: GitIntegration;
  private readonly scratchRoot?: string;
  private readonly program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string };
  private readonly systemContext?: { resources?: boolean; agentCombinations?: boolean; systemSummary?: boolean; requestModelAccess?: boolean };
  private readonly access?: () => ResolvedAccessPolicy;
  private readonly autoWake: boolean;
  private readonly generation: number;
  private readonly lifecycle: OperationLifecycle;
  private readonly unsubscribeStore: () => void;
  private pumping = false;
  constructor(store: TaskStore, actions: Record<string, ActionAdapter>, extras: { fallback?: ActionAdapter; catalog?: Catalog; models?: () => ModelEntry[]; preferences?: Partial<Record<ModelEntry['grade'], string[]>> | (() => Partial<Record<ModelEntry['grade'], string[]>> | undefined); git?: GitIntegration; scratchRoot?: string; program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string }; autoWake?: boolean; systemContext?: { resources?: boolean; agentCombinations?: boolean; systemSummary?: boolean; requestModelAccess?: boolean }; access?: () => ResolvedAccessPolicy } = {}) {
    this.store = store; this.actions = actions;
    if (extras.fallback) this.fallback = extras.fallback;
    if (extras.catalog) this.catalog = extras.catalog;
    if (extras.models) this.models = extras.models;
    if (extras.preferences) this.preferences = extras.preferences;
    if (extras.git) this.git = extras.git;
    if (extras.scratchRoot) this.scratchRoot = extras.scratchRoot;
    if (extras.program) this.program = extras.program;
    if (extras.systemContext) this.systemContext = extras.systemContext;
    if (extras.access) this.access = extras.access;
    this.autoWake = Boolean(extras.autoWake);
    this.unsubscribeStore = store.onEvent(type => {
      if (this.autoWake && type === 'problem.routed') queueMicrotask(() => this.kick());
    });
    this.lifecycle = new OperationLifecycle(store, {
      advance: taskId => this.advance(taskId),
    });
    this.generation = this.lifecycle.recover();
    const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    if (active_task && this.git) {
      this.git.restore(active_task);
      this.deliver(active_task);
    }
  }

  async drain() {
    this.stopping = true;
    this.unsubscribeStore();
    // Shutdown is bounded. A provider stream can hang indefinitely; the
    // operation is already durable and is recovered on the next start, so the
    // daemon must not wait past its stop deadline for that worker.
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise<void>(resolve => setTimeout(resolve, 2_000)),
    ]);
  }

  report(id: string, generation: number, result: OperationResult) {
    const taskId = this.lifecycle.report(id, generation, result);
    this.deliver(taskId);
    if (this.autoWake) this.kick();
  }

  async reconcile(id: string) {
    const work = (async () => {
      const initial = this.lifecycle.get(id);
      if (!initial) throw new RuntimeError('not_found', 'Operation not found');
      if (initial.state !== 'unknown') return;
      const adapter = Object.hasOwn(this.actions, initial.operation.action) ? this.actions[initial.operation.action] : undefined;
      if (!adapter?.reconcile) throw new RuntimeError('reconciliation_unavailable', 'No external reconciliation adapter is registered');
      const taskId = await this.lifecycle.reconcile(id, operation => adapter.reconcile!(operation), {
        integrate: async operation => {
          if (!this.git) return;
          const merged = await this.git.exclusive(operation.taskId, () => this.git!.integrate(operation));
          if (merged && !merged.ok) throw new RuntimeError('git_conflict', merged.conflicts.join(', '));
        },
      });
      if (taskId) this.deliver(taskId);
    })();
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
  }

  async steer(operationId: string, text: string) {
    await this.lifecycle.steer(operationId, async operation => {
      const adapter = Object.hasOwn(this.actions, operation.action) ? this.actions[operation.action] : undefined;
      if (!adapter?.steer) throw new RuntimeError('steering_unavailable', 'The active Agent does not support steering messages');
      await adapter.steer(operation, text);
    });
  }

  /** Called only inside the authenticated user command transaction. */
  answer(taskId: string, questionId: string, answer: Answer) {
    this.lifecycle.answer(taskId, questionId, answer, this.models);
  }

  /** Hand a main-owned problem to the user with an explanation. */
  escalate(taskId: string, questionId: string, prompt: string) {
    this.lifecycle.escalate(taskId, questionId, prompt);
    if (this.autoWake) this.kick();
  }

  finish(taskId: string) { this.deliver(taskId); }

  private block(node: ExecutionNodeRow, kind: string, data: Json, operationId: string | null = null) {
    this.lifecycle.block(node.task_id, node.id, kind, data, operationId);
  }

  async runReady() {
    const executions = this.readyNodes().map(node => this.run(node));
    const result = Promise.allSettled(executions);
    this.pending.add(result);
    try {
      const outcomes = await result;
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return { dispatched: outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value).length };
    }
    finally { this.pending.delete(result); }
  }

  /** Dispatch newly ready work as completions land, without waiting for a slow sibling in the same batch. */
  async drive() {
    this.driveActive += 1;
    try {
      let dispatched = 0;
      const running = new Set<Promise<boolean>>();
      while (!this.stopping) {
        const ready = this.readyNodes();
        const started: Promise<boolean>[] = [];
        for (const node of ready) {
          const spec = JSON.parse(node.spec) as NodeSpec;
          if (this.remainingSlots(spec.kind) <= 0) continue;
          const work = this.run(node);
          started.push(work);
          running.add(work);
          work.finally(() => running.delete(work));
        }
        dispatched += started.length;
        if (running.size === 0) break;
        if (started.length < ready.length) {
          // The execution cap was hit; some operations may now be parked waiting
          // for a credential slot. Re-scan shortly so a node on a free credential
          // is not held behind waiters, which no longer consume execution slots.
          await new Promise(resolve => setTimeout(resolve, 20));
          continue;
        }
        await Promise.race([...running, new Promise<void>(resolve => this.driveWaiters.push(resolve))]);
      }
      return { dispatched };
    } finally {
      this.driveActive -= 1;
    }
  }

  /** Dispatch every currently-ready node and return without waiting for the
   * workers. The long-running host loop uses this so a hung worker can never
   * starve unrelated tasks; callers that need completion use drive(). */
  async pump() {
    if (this.stopping || this.pumping) return { dispatched: 0 };
    this.pumping = true;
    try {
      let dispatched = 0;
      for (const node of this.readyNodes()) {
        const spec = JSON.parse(node.spec) as NodeSpec;
        if (this.remainingSlots(spec.kind) <= 0) continue;
        void this.run(node).catch(() => undefined);
        dispatched += 1;
      }
      return { dispatched };
    } finally {
      this.pumping = false;
    }
  }

  /** Ensure a newly queued message is dispatched even if no drive loop is active. */
  kick() {
    if (this.driveActive === 0) void this.drive().catch(() => undefined);
  }

  private remainingSlots(kind: NodeSpec['kind']) {
    return executionLimit(kind === 'agent' ? 'agent' : 'program') - occupiedSlots(this.store, kind === 'agent' ? 'agent' : 'program');
  }

  private wakeDrive() {
    const waiters = this.driveWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  /** Conversation masters are their own interactive lane, ahead of the single active task. */
  private laneTasks(): string[] {
    const chatting = (this.store.db.prepare("SELECT id FROM tasks WHERE phase='chatting' ORDER BY created_seq").all() as { id: string }[]).map(row => row.id);
    const { active_task } = this.store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    if (active_task && !chatting.includes(active_task) && this.store.task(active_task).phase !== 'chatting') chatting.push(active_task);
    return chatting;
  }

  private readyNodes(): ExecutionNodeRow[] {
    if (this.stopping) return [];
    const nodes: ExecutionNodeRow[] = [];
    const fullAccess = isFullAccess(this.access?.());
    for (const taskId of this.laneTasks()) {
      if (!fullAccess && this.store.task(taskId).paused) continue;
      nodes.push(...this.readyNodesFor(taskId));
    }
    return nodes;
  }

  private readyNodesFor(taskId: string): ExecutionNodeRow[] {
    const task = this.store.task(taskId);
    if (task.phase === 'chatting') {
      // Without a confirmed graph the conversation master is the only node that
      // may run; each turn consumes exactly one pending or queued user message.
      // A master parked on its own main-owned problem must not be retried by the
      // drive loop: the identical failure would repeat forever. It resumes only
      // after resolveProblem or configuration recovery clears that problem.
      return this.store.db.prepare(`SELECT * FROM nodes n
        WHERE n.task_id=? AND n.status='pending' AND json_extract(n.spec,'$.role')='master'
          AND NOT EXISTS (SELECT 1 FROM questions q
            WHERE q.task_id=n.task_id AND q.node_id=n.id AND q.status='open' AND q.owner='main')
        ORDER BY n.rowid`).all(taskId) as ExecutionNodeRow[];
    }
    if (task.phase === 'discussing') return this.store.db.prepare("SELECT * FROM nodes WHERE task_id=? AND status='pending' ORDER BY rowid").all(taskId) as ExecutionNodeRow[];
    if (task.phase !== 'running') return [];
    let nodes: ExecutionNodeRow[];
    let graph: ReturnType<typeof loadGraph>;
    while (true) {
      nodes = this.store.db.prepare("SELECT * FROM nodes WHERE task_id=? AND status='pending' ORDER BY rowid").all(taskId) as ExecutionNodeRow[];
      graph = loadGraph(this.store, taskId);
      // The discussion-only master node is not part of the confirmed graph.
      nodes = nodes.filter(node => graph.plan.nodes.has(node.id));
      const skipped = nodes.filter(node => graph.readiness(node.id) === 'skip');
      if (!skipped.length) break;
      this.store.transaction(() => {
        for (const node of skipped) {
          this.store.db.prepare("UPDATE nodes SET status='skipped',output=NULL WHERE task_id=? AND id=?").run(taskId, node.id);
          this.store.db.prepare("UPDATE activations SET state='skipped' WHERE id=?").run(node.activation_id);
          this.store.event(taskId, 'node.skipped', { nodeId: node.id, reason: 'inactive_route' });
        }
      });
    }
    return nodes.filter(node => graph.readiness(node.id) === 'ready');
  }

  private async run(node: ExecutionNodeRow): Promise<boolean> {
    const work = this.execute(node);
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); this.wakeDrive(); }
  }

  private async execute(node: ExecutionNodeRow): Promise<boolean> {
    const accessPolicy = this.access?.() ?? resolveAccessPolicy(standardAccessPolicy());
    const fullAccess = isFullAccess(accessPolicy);
    if (this.stopping || (!fullAccess && this.store.task(node.task_id).paused)) return false;
    if ((this.store.db.prepare('SELECT status FROM nodes WHERE task_id=? AND id=?').get(node.task_id, node.id) as { status: string }).status !== 'pending') return false;
    const spec = JSON.parse(node.spec) as NodeSpec;
    const adapter = spec.action === 'graph.verify'
      ? graphVerifier(this.store, spec)
      : spec.action === 'graph.human_check'
        ? humanCheckNode(this.store)
        : spec.action === 'graph.command'
          ? workspaceCommandNode({
              store: this.store,
              spec,
              ...(this.git ? { git: this.git } : {}),
              ...(this.scratchRoot ? { scratchRoot: this.scratchRoot } : {}),
              ...(this.program ? { program: this.program } : {}),
              stopped: () => this.stopping,
            })
          : Object.hasOwn(this.actions, spec.action)
            ? this.actions[spec.action]
            : spec.kind === 'agent'
              ? this.fallback
              : undefined;
    if (!adapter || adapter.kind !== spec.kind) {
      this.store.transaction(() => this.block(node, 'adapter_error', { reason: `No ${spec.kind} adapter for ${spec.action}` }));
      return false;
    }
    if (spec.action === 'graph.human_check') {
      const task = this.store.task(node.task_id);
      const resolved = this.store.db.prepare("SELECT data FROM questions WHERE task_id=? AND node_id=? AND kind='human_check' AND status='resolved'").all(node.task_id, node.id) as { data: string }[];
      const bound = resolved.some(row => {
        const data = JSON.parse(row.data) as { activationId?: string; commitSha?: string | null };
        return data.activationId === node.activation_id && (data.commitSha ?? null) === (task.integration_sha ?? null);
      });
      if (!bound) {
        this.store.transaction(() => this.block(node, 'human_check', { prompt: 'A human acceptance check is required', activationId: node.activation_id, commitSha: task.integration_sha ?? null }));
        return false;
      }
    }
    if (spec.kind === 'agent' && this.models && node.instance_id) {
      const preferences = typeof this.preferences === 'function' ? this.preferences() : this.preferences;
      const selected = pickModel({
        store: this.store,
        spec,
        node,
        models: this.models,
        ...(this.catalog ? { catalog: this.catalog } : {}),
        ...(preferences ? { preferences } : {}),
      });
      if (!selected) {
        this.store.transaction(() => this.block(node, 'model_unavailable', { requested: spec.model ?? null }));
        return false;
      }
      this.store.db.prepare('UPDATE instances SET model=?,definition_version=? WHERE id=?').run(selected.id, spec.definitionVersion ?? null, node.instance_id);
      // Freeze the underlying identity at selection time: scripted/local
      // adapters create no invocation rows, yet review independence still
      // needs the model this implementer was actually bound to. Later config
      // edits must never rewrite this record.
      const identity = selected.modelId ?? selected.id;
      recordModelUse(this.store, node.instance_id, identity);
      if (spec.model && spec.model !== selected.id) this.store.event(node.task_id, 'model.switched', { nodeId: node.id, from: spec.model, to: selected.id, instanceId: node.instance_id });
    }
    const baseGrants = JSON.parse((this.store.db.prepare('SELECT grants FROM projects WHERE id=?').get(this.store.task(node.task_id).project_id) as { grants: string }).grants) as string[];
    const grants = [...new Set([...baseGrants, ...(this.store.db.prepare('SELECT grant FROM task_grants WHERE task_id=?').all(node.task_id) as { grant: string }[]).map(row => row.grant)])];
    const requiredGrant = adapter.grant;
    if (requiredGrant && !grants.includes(requiredGrant)) {
      if (accessPolicy.autoApprove.permission) {
        this.store.transaction(() => {
          insertQuestion(this.store, {
            taskId: node.task_id,
            nodeId: node.id,
            kind: 'permission',
            data: { grant: requiredGrant },
            autoAnswer: {
              answer: { type: 'grant', grant: requiredGrant },
              policyDigest: accessPolicy.digest,
            },
          });
        });
        grants.push(requiredGrant);
      } else {
        this.store.transaction(() => this.block(node, 'permission', { grant: requiredGrant }));
        return false;
      }
    }
    if (occupiedSlots(this.store, spec.kind === 'agent' ? 'agent' : 'program') >= executionLimit(spec.kind === 'agent' ? 'agent' : 'program')) return false;
    const reservation = spec.kind === 'agent' ? adapter.reserveTokens : 0;
    if (reservation === undefined || !Number.isSafeInteger(reservation) || reservation < 0) throw new RuntimeError('invalid_adapter', 'A bounded token reservation is required');
    if (node.instance_id && !fullAccess) {
      try {
        assertWithinBudget(this.store, node.instance_id, reservation);
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== 'budget') throw error;
        this.store.transaction(() => this.block(node, 'budget', { reason: error.message, requested: reservation }));
        return false;
      }
    }
    let workspace: string | undefined;
    try { workspace = this.git?.workspace(node.task_id, node.instance_id, node.id, spec.kind); }
    catch (error) {
      this.store.transaction(() => this.block(node, 'adapter_error', { reason: String(error) }));
      return false;
    }
    let operation: Operation;
    let handoffPackage: ContextHandoffPackage | undefined;
    let conversation: ReturnType<typeof conversationForTask>;
    let chatMessages: ReturnType<typeof pendingMessages> = [];
    let reviewNode = false;
    try {
      operation = this.lifecycle.admit({
        node: {
          id: node.id,
          taskId: node.task_id,
          activationId: node.activation_id,
        },
        reservation,
        prepare: attempt => {
          const task = this.store.task(node.task_id);
          conversation = task.phase === 'chatting' ? conversationForTask(this.store, node.task_id) : undefined;
          chatMessages = conversation ? pendingMessages(this.store, conversation.id, 1) : [];
          const graph = task.phase === 'discussing' || task.phase === 'chatting' ? undefined : loadGraph(this.store, node.task_id);
          const dependencies = graph ? graph.inputs(node.id) : {};
          const dependencySources = graph ? graph.sources(node.id) : {};
          const inputVersions = Object.fromEntries(Object.entries(dependencySources).map(([id, sources]) => [
            id,
            sources.map(source => ({ activationId: source.activationId, outputVersion: source.outputVersion })),
          ]));
          const answers = (this.store.db.prepare("SELECT id,answer FROM questions WHERE task_id=? AND node_id=? AND kind IN ('waiting','system_change') AND status='resolved' ORDER BY rowid")
            .all(node.task_id, node.id) as { id: string; answer: string }[])
            .map(row => ({ questionId: row.id, value: (JSON.parse(row.answer) as { value: Json }).value }));
          const messages = task.phase === 'chatting'
            ? chatMessages.map(message => {
                const data = message.data ? JSON.parse(message.data) as { attachments?: AttachmentInput[]; command?: 'compact' } : null;
                return {
                  id: message.id,
                  text: message.text,
                  requirementVersion: task.requirement_version,
                  ...(data?.attachments?.length ? { attachments: data.attachments } : {}),
                  ...(data?.command ? { command: data.command } : {}),
                };
              })
            : (this.store.db.prepare("SELECT data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor")
                .all(node.task_id) as { data: string }[])
              .map(row => JSON.parse(row.data) as { text?: string; request?: string; requirementVersion?: number })
              .map(message => ({ text: message.text ?? message.request!, requirementVersion: message.requirementVersion ?? 1 }));
          const latest = this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?')
            .get(node.task_id, task.latest_proposal) as { spec: string } | undefined;
          const proposal = latest ? JSON.parse(latest.spec) as Proposal : undefined;
          reviewNode = spec.kind === 'agent' && isReviewer(spec, this.catalog);
          const agentContext = spec.kind === 'agent'
            ? resolveAgentContext(this.store, {
                taskId: node.task_id,
                nodeId: node.id,
                spec,
                review: reviewNode,
                excludedModels: reviewNode ? implementerModels(this.store, spec, node) : [],
              })
            : undefined;
          const intent: OperationIntent = {
            taskId: node.task_id,
            nodeId: node.id,
            instanceId: node.instance_id,
            kind: spec.kind,
            action: spec.action,
            input: spec.input ?? null,
            dependencies,
            proposalVersion: task.accepted_proposal ?? 0,
            requirementVersion: task.requirement_version,
            context: {
              previousOutput: node.output ? JSON.parse(node.output) as Json : null,
              answers,
              ...(messages.length ? { messages } : {}),
              ...(agentContext ? { agentContext } : {}),
            },
            grants,
            accessPolicy,
            activationId: node.activation_id,
            graphVersion: task.graph_version,
            dependencySources,
            inputVersions,
            ...(workspace ? { workspace } : {}),
          };
          const graphBriefing = task.accepted_proposal !== null && spec.kind === 'agent'
            ? [...loadGraph(this.store, node.task_id).plan.nodes.values()]
            : undefined;
          const verifier = graphBriefing?.find(candidate =>
            candidate.action === 'graph.verify' && candidate.verifier?.reportNodes.includes(spec.id));
          const review = verifier?.verifier ? [{ kind: verifier.verifier.kind }] : undefined;
          const conversationStatus = conversation ? conversationDigest(this.store, conversation.id) : undefined;
          if (this.catalog) {
            let capabilities: { id: string; version: string }[] | undefined;
            if (spec.definitionVersion) {
              try { capabilities = this.catalog.definition(spec.definitionVersion).capabilities; }
              catch { /* unpublished definitions still get a request briefing */ }
            }
            intent.context.briefing = briefing(intent, {
              request: task.request,
              ...(proposal?.summary ? { summary: proposal.summary } : {}),
              acceptance: proposal?.acceptance ?? [],
              ...(capabilities?.length ? { capabilities } : {}),
              ...(graphBriefing?.length ? { graph: graphBriefing } : {}),
              ...(review ? { review } : {}),
              ...(conversationStatus ? { conversation: conversationStatus } : {}),
              ...(task.decision_digest ? { decisions: task.decision_digest } : {}),
              ...(spec.role === 'master' ? {
                catalog: {
                  definitions: this.catalog.availableAgentDefinitions().map(item => `${item.id}@${item.version}`),
                  agentCombinations: this.catalog.agentCombinations().map(item => ({
                    id: item.id,
                    name: item.name,
                    description: item.description,
                    recommendedGrade: item.recommendedGrade,
                    status: item.status,
                  })),
                },
                systemContext: {
                  ...this.systemContext,
                  requestModelAccess: Boolean(conversation && spec.role === 'master' && this.systemContext?.requestModelAccess),
                },
              } : {}),
            });
          } else {
            intent.context.briefing = briefing(intent, {
              request: task.request,
              ...(proposal?.summary ? { summary: proposal.summary } : {}),
              acceptance: proposal?.acceptance ?? [],
              ...(graphBriefing?.length ? { graph: graphBriefing } : {}),
              ...(review ? { review } : {}),
              ...(conversationStatus ? { conversation: conversationStatus } : {}),
              ...(task.decision_digest ? { decisions: task.decision_digest } : {}),
              ...(spec.role === 'master' && this.systemContext ? {
                systemContext: {
                  ...this.systemContext,
                  requestModelAccess: Boolean(conversation && spec.role === 'master' && this.systemContext?.requestModelAccess),
                },
              } : {}),
            });
          }
          const predecessor = spec.kind === 'agent' && agentContext?.mode === 'fresh' && graph
            ? buildPredecessorHandoffs(this.store, graph, spec)
            : { policies: [], projections: [] };
          const resultHandoffRequired = proposal ? requiresResultHandoff(proposal, node.id) : false;
          const outputSchema = reviewNode
            ? { kind: 'independent_review', version: 1 } as const
            : proposal ? outputSchemaForNode(proposal, node.id) : { kind: 'agent_result', version: 1 } as const;
          intent.context.outputSchema = outputSchema;
          const schemaInstruction = resultHandoffRequired
            ? [
                reviewNode
                  ? 'This independent review also feeds a downstream Fresh Agent through a result_handoff edge.'
                  : 'A downstream Fresh Agent requires a result_handoff@1.',
                reviewNode
                  ? 'Submit the normal independent_review JSON with an additional top-level "resultHandoff" object shaped as:'
                  : 'Call submit_result with outputJson exactly shaped as:',
                '{"schemaVersion":1,"objective":"<bounded goal>","outcome":"completed|partial|blocked","workSummary":"<bounded work result summary>","changes":[{"kind":"file|artifact|external","path":"<the path you wrote; relative to your work copy is fine>","digest":"<sha256, or omit it and the host hashes the file>","artifactId":"<shared artifact id when published>","version":"<exact shared version>","uri":"<artifact uri when present>","summary":"<bounded summary>"}],"decisions":[{"decision":"...","rationale":"...","evidenceRefs":[]}],"verification":[{"summary":"...","result":"pass|fail|unknown","evidenceRefs":[]}],"knownLimits":[],"openQuestions":[],"nextActions":[]}',
                'The host checks every file change against the bytes in your work copy, so name the files you actually wrote; keep every top-level field even when its list is empty. Do not include hidden chain-of-thought, transcript, or tool history. Put large content in artifacts and reference exact paths and digests.',
              ].join('\n')
            : '';
          // A retry whose previous attempt already landed the work is a handoff
          // repair, not a second run of the task: send the failure and the prior
          // submission so the worker reconciles instead of re-implementing.
          const repair = spec.kind === 'agent'
            ? resultHandoffRepair(this.store, { taskId: node.task_id, nodeId: node.id, activationId: node.activation_id })
            : undefined;
          if (repair) intent.context.briefing = renderResultHandoffRepair(repair, { decisions: answers });
          intent.context.briefing = [
            intent.context.briefing,
            renderPredecessorHandoffs(predecessor.projections),
            schemaInstruction,
          ].filter(Boolean).join('\n\n');
          if (agentContext) {
            if (reviewNode && (agentContext.mode !== 'fresh' || !agentContext.reviewPolicy
              || !agentContext.reviewPolicy.freshRequired || !agentContext.reviewPolicy.evidenceOnly)) {
              throw new RuntimeError('context_rejected', 'Independent review requires a fresh evidence-only handoff');
            }
            const artifactRefs = Object.values(dependencySources).flatMap(sources =>
              sources.flatMap(source => source.artifacts.map(artifact => ({ path: artifact.path, digest: artifact.digest }))));
            handoffPackage = {
              mode: agentContext.mode,
              purpose: agentContext.purpose,
              independence: agentContext.independence,
              requestedFacts: agentContext.requestedFacts,
              reasonCode: agentContext.reasonCode,
              sourceNodeId: agentContext.sourceNodeId ?? null,
              sourceInstanceId: agentContext.sourceInstanceId ?? null,
              sourceSessionId: agentContext.sourceSessionId ?? null,
              sourceLeafId: agentContext.sourceLeafId ?? null,
              summary: proposal?.summary ?? task.request,
              decisions: proposal?.decisions ?? (task.decision_digest ? [task.decision_digest] : []),
              acceptance: proposal?.acceptance ?? [],
              artifactRefs,
              predecessorPolicies: predecessor.policies,
              predecessorHandoffs: predecessor.projections,
              outputSchema,
              briefing: intent.context.briefing ?? '',
            };
            const handoffDigest = digest(handoffPackage);
            const constraintsDigest = handoffConstraintsDigest(handoffPackage);
            intent.context.agentContext = { ...agentContext, handoffDigest, constraintsDigest };
          }
          return intent;
        },
        afterIntent: admitted => {
          const agentContext = admitted.context.agentContext;
          if (agentContext && handoffPackage) {
            freezeContextHandoff(this.store, agentContext, {
              taskId: admitted.taskId,
              operationId: admitted.id,
              nodeId: admitted.nodeId,
              instanceId: admitted.instanceId!,
              package: handoffPackage,
            });
            this.store.event(admitted.taskId, 'context.requested', {
              nodeId: admitted.nodeId,
              operationId: admitted.id,
              purpose: agentContext.purpose,
              independence: agentContext.independence,
              sourceNodeId: agentContext.sourceNodeId ?? null,
            });
            this.store.event(admitted.taskId, 'context.mode_selected', {
              nodeId: admitted.nodeId,
              operationId: admitted.id,
              mode: agentContext.mode,
              reasonCode: agentContext.reasonCode,
              sourceInstanceId: agentContext.sourceInstanceId ?? null,
            });
            this.store.event(admitted.taskId, 'context.handoff_policy_selected', {
              nodeId: admitted.nodeId,
              operationId: admitted.id,
              applicable: agentContext.mode === 'fresh',
              policies: handoffPackage.predecessorPolicies as unknown as Json,
            });
            if (agentContext.mode === 'fresh' && handoffPackage.predecessorPolicies.some(policy => policy.mode === 'evidence_only')) {
              this.store.event(admitted.taskId, 'context.evidence_only_frozen', {
                nodeId: admitted.nodeId,
                operationId: admitted.id,
                policies: handoffPackage.predecessorPolicies as unknown as Json,
              });
            }
            this.store.event(admitted.taskId, 'context.handoff_frozen', {
              nodeId: admitted.nodeId,
              operationId: admitted.id,
              handoffId: agentContext.handoffId,
              digest: agentContext.handoffDigest,
              constraintsDigest: agentContext.constraintsDigest,
            });
            if (reviewNode) {
              this.store.event(admitted.taskId, 'review.independence_checked', {
                nodeId: admitted.nodeId,
                operationId: admitted.id,
                handoffDigest: agentContext.handoffDigest,
                constraintsDigest: agentContext.constraintsDigest,
                transcriptIncluded: false,
                independence: agentContext.independence,
                policy: agentContext.reviewPolicy,
                policyDigest: digest(agentContext.reviewPolicy),
              });
            }
          }
          if (conversation && chatMessages.length) {
            deliverMessages(this.store, admitted.id, admitted.attempt, chatMessages);
          }
        },
      });
    } catch (error) {
      if (error instanceof RuntimeError && error.code.startsWith('context_')) {
        this.store.transaction(() => {
          const data = {
            reason: error.message,
            code: error.code,
            requiredFacts: (spec.context?.requiredFacts ?? []) as unknown as Json,
            policy: spec.context?.independence ?? 'none',
          };
          this.store.event(node.task_id, 'context.rejected', { nodeId: node.id, ...data });
          this.block(node, 'context_rejected', data);
        });
        return false;
      }
      throw error;
    }
    let dispatch: () => Promise<OperationResult>;
    try {
      dispatch = await adapter.prepare(operation);
      if (typeof dispatch !== 'function') throw new RuntimeError('invalid_adapter', 'prepare must return a dispatch callback');
    } catch (error) {
      this.lifecycle.markPreparationFailed(operation.id, String(error));
      return false;
    }
    if (this.stopping || (!fullAccess && this.store.task(node.task_id).paused)) {
      this.lifecycle.cancelBeforeDispatch(operation.id);
      return false;
    }
    this.lifecycle.dispatch(operation);
    let quiescent = false;
    try {
      const usesGit = Boolean(this.git && this.store.task(node.task_id).integration_branch);
      let result: OperationResult;
      if (usesGit && this.git && this.locksIntegration(spec, node.task_id)) {
        result = await this.git.exclusive(node.task_id, dispatch);
        quiescent = true;
      } else {
        result = await dispatch();
        quiescent = true;
      }
      if (usesGit && this.git && spec.kind === 'agent' && result.outcome === 'completed') {
        const merged = await this.git.exclusive(node.task_id, () => this.git!.integrate(operation));
        if (merged && !merged.ok) result = { ...result, outcome: 'failed', output: { conflicts: merged.conflicts } };
      }
      try {
        this.report(operation.id, operation.generation, result);
      } catch (error) {
        // A refused document is not an uncertain external outcome: the worker
        // finished and we hold its result. Keep the work, record the refusal and
        // hand the defects to whoever owns execution instead of parking the node
        // as unknown and re-running the implementation.
        if (!(error instanceof RuntimeError) || !SUBMISSION_DEFECT_CODES.has(error.code)) throw error;
        this.report(operation.id, operation.generation, nonCompliantResult(result, error.message, [{
          path: '$', class: 'semantic', expected: 'a result the harness can settle', got: error.message,
        }]));
      }
    } catch (error) {
      // A gate refusal means the refused send never happened. With no prior
      // provider request the operation is not_sent; after partial work it is
      // interrupted with its known usage accounted once and its session kept,
      // so the node can resume on the same instance. Neither case advances the
      // graph or hides the worker state.
      const refusal = error instanceof RuntimeError ? error : undefined;
      if (refusal && this.lifecycle.handleDispatchRefusal(operation, refusal, reservation)) return false;
      this.lifecycle.markUncertain(operation, error, quiescent);
    }
    return true;
  }

  private locksIntegration(spec: NodeSpec, taskId: string) {
    if (spec.kind === 'program') return true;
    return (spec.dependsOn ?? []).some(id => {
      const row = this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(taskId, id) as { spec: string } | undefined;
      return !!row && (JSON.parse(row.spec) as NodeSpec).kind === 'program';
    });
  }

  private readyToComplete(taskId: string) {
    const task = this.store.task(taskId);
    if (task.phase !== 'running' || !task.accepted_proposal) return false;
    const graph = loadGraph(this.store, taskId);
    if ([...graph.plan.nodes.keys()].some(id => !['succeeded', 'skipped'].includes(graph.status(id)))) return false;
    if (this.store.db.prepare("SELECT id FROM questions WHERE task_id=? AND status='open'").get(taskId)) return false;
    const proposal = JSON.parse((this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(taskId, task.accepted_proposal) as { spec: string }).spec) as Proposal;
    const evidence = this.store.db.prepare('SELECT acceptance_id,commit_sha FROM evidence WHERE task_id=? AND proposal_version=? AND requirement_version=? AND valid=1').all(taskId, task.accepted_proposal, task.requirement_version) as { acceptance_id: string; commit_sha: string | null }[];
    const sha = task.integration_sha;
    if (!proposal.acceptance.every(item => evidence.some(row => row.acceptance_id === item.id && (!sha || row.commit_sha === sha)))) return false;
    if (task.integration_branch && !independentReviewReady(this.store, taskId, this.catalog)) {
      // Independent review guards a real code delivery. When the integrated
      // tree is identical to the recorded target there is nothing to merge,
      // so a no-op delivery does not need a reviewer; the acceptance evidence
      // and node completion checks above still apply.
      if (!task.integration_sha || task.integration_sha !== task.target_sha) return false;
    }
    return true;
  }

  private completeTask(taskId: string) {
    const task = this.store.task(taskId);
    this.store.db.prepare("UPDATE tasks SET phase='completed' WHERE id=?").run(taskId);
    const next = this.store.db.prepare("SELECT id FROM tasks WHERE phase='queued' ORDER BY created_seq LIMIT 1").get() as { id: string } | undefined;
    this.store.db.prepare('UPDATE runtime SET active_task=?').run(next?.id ?? null);
    this.store.event(taskId, 'task.completed', { proposalVersion: task.accepted_proposal });
    if (next) {
      this.store.db.prepare("UPDATE tasks SET phase='running' WHERE id=?").run(next.id);
      this.store.event(next.id, 'task.started', {});
    }
  }

  private deliver(taskId: string) {
    if (!this.readyToComplete(taskId)) return;
    if (this.git) {
      const recovered = this.git.restore(taskId);
      if (this.store.task(taskId).integration_branch) {
        const result = recovered?.status === 'merged' ? recovered : this.git.tryDeliver(taskId);
        if (result.status === 'recheck') return;
        if (result.status === 'blocked') {
          const task = this.store.task(taskId);
          const proposal = JSON.parse((this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(taskId, task.accepted_proposal!) as { spec: string }).spec) as Proposal;
          const node = this.store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(taskId, proposal.acceptance[0]!.checkNode) as ExecutionNodeRow;
          this.store.transaction(() => this.block(node, String((result.data as { kind?: string })?.kind ?? 'git_conflict'), result.data ?? { reason: 'Git delivery blocked' }));
          return;
        }
        if (result.status !== 'merged' && result.status !== 'skip') return;
      }
    }
    this.store.transaction(() => this.completeTask(taskId));
  }

  private advance(taskId: string) {
    if (this.store.task(taskId).integration_branch) return;
    if (!this.readyToComplete(taskId)) return;
    this.completeTask(taskId);
  }
}
