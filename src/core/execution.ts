import { releaseTaskSlot } from './task-queue.ts';
import { GraphRuntime } from './graph-runtime.ts';
import { pendingRsiContinuation, consumeRsiContinuation } from './rsi-continuation.ts';
import { pendingWakes, renderWakes } from './wake-ledger.ts';
import { pendingPauseContinuation, consumePauseContinuation } from './pause-continuation.ts';
import { canonicalJson, type TaskStore } from './store.ts';
import { isFullAccess, resolveAccessPolicy, standardAccessPolicy, type ResolvedAccessPolicy } from './access-policy.ts';
import { assertWithinBudget, recordModelUse } from './budget-ledger.ts';
import { conversationDigest, conversationForTask, deliverMessages, pendingMessages } from './conversation.ts';
import { isSummaryLeakRetry } from '../runtime/compaction.ts';
import { digest, freezeContextHandoff, handoffConstraintsDigest, resolveAgentContext } from './context.ts';
import { KernelStore } from './kernel-store.ts';
import { pickModel } from './model-selection.ts';
import { OperationLifecycle, type OperationIntent } from './operation-lifecycle.ts';
import { insertQuestion, isMasterParked } from './question-routing.ts';
import { briefing } from '../catalog/briefing.ts';
import type { Catalog } from '../catalog/catalog.ts';
import type { ModelEntry } from '../catalog/models.ts';
import type { GitIntegration } from '../git/integration.ts';
import type { ArtifactWorkspace } from './artifact-workspace.ts';
import { executionLimit, occupiedSlots } from '../runtime/execution-slots.ts';
import { RuntimeError, type ActionAdapter, type Answer, type AttachmentInput, type ContextHandoffPackage, type Json, type NodeSpec, type Operation, type OperationResult, type NativeProposal } from './types.ts';

type ExecutionNodeRow = { id: string; task_id: string; spec: string; instance_id: string | null; status: string; output: string | null; activation_id: string };

/**
 * Settlement failures that describe a result the harness refuses to use, as
 * opposed to an external outcome nobody can observe. Those stay with the work
 * and become a repair problem instead of an uncertain operation.
 */
const SUBMISSION_DEFECT_CODES = new Set(['invalid_result', 'invalid_evidence']);

/** Main execution state machine; graph agents run through the native lane. */
export class Execution {
  private readonly pending = new Set<Promise<unknown>>();
  private driveActive = 0;
  private stopping = false;
  private readonly driveWaiters: (() => void)[] = [];
  private readonly store: TaskStore;
  /**
   * §13.8: the v2 graph lane. A task on the v2 kernel has no `nodes` rows, so the old scan
   * can never see it and its queues stay inert. This hook names the v2 graphs that
   * currently have queued work, and runs one when the drive loop drains it. It is injected
   * (rather than built here) because the kernel, the resident host and the node config all
   * live in the runtime that opens this executor.
   */
  private readonly activeGraphs = new Map<string, Promise<unknown>>();
  private readonly graphs?: () => { taskId: string; run: () => Promise<{ drained: boolean }> }[];
  private readonly actions: Record<string, ActionAdapter>;
  private readonly fallback?: ActionAdapter;
  private readonly catalog?: Catalog;
  private readonly models?: () => ModelEntry[];
  private readonly preferences?: Partial<Record<ModelEntry['grade'], string[]>> | (() => Partial<Record<ModelEntry['grade'], string[]>> | undefined);
  private readonly git?: GitIntegration;
  private readonly systemContext?: { resources?: boolean; agentCombinations?: boolean; systemSummary?: boolean };
  private readonly access?: () => ResolvedAccessPolicy;
  private readonly dispatchAllowed?: () => boolean;
  private readonly autoWake: boolean;
  private readonly generation: number;
  private readonly lifecycle: OperationLifecycle;
  private readonly unsubscribeStore: () => void;
  private pumping = false;
  constructor(store: TaskStore, actions: Record<string, ActionAdapter>, extras: { fallback?: ActionAdapter; catalog?: Catalog; models?: () => ModelEntry[]; preferences?: Partial<Record<ModelEntry['grade'], string[]>> | (() => Partial<Record<ModelEntry['grade'], string[]>> | undefined); git?: GitIntegration; autoWake?: boolean; dispatchAllowed?: () => boolean; graphs?: () => { taskId: string; run: () => Promise<{ drained: boolean }> }[]; systemContext?: { resources?: boolean; agentCombinations?: boolean; systemSummary?: boolean }; access?: () => ResolvedAccessPolicy; artifacts?: ArtifactWorkspace } = {}) {
    this.store = store; this.actions = actions;
    if (extras.fallback) this.fallback = extras.fallback;
    if (extras.catalog) this.catalog = extras.catalog;
    if (extras.models) this.models = extras.models;
    if (extras.preferences) this.preferences = extras.preferences;
    if (extras.git) this.git = extras.git;
    if (extras.systemContext) this.systemContext = extras.systemContext;
    if (extras.access) this.access = extras.access;
    if (extras.dispatchAllowed) this.dispatchAllowed = extras.dispatchAllowed;
    if (extras.graphs) this.graphs = extras.graphs;
    this.autoWake = Boolean(extras.autoWake);
    this.unsubscribeStore = store.onEvent(type => {
      if (this.autoWake && type === 'problem.routed') queueMicrotask(() => this.kick());
    });
    this.lifecycle = new OperationLifecycle(store, {
      canReplayBeforeSend: operation => {
        const adapter = Object.hasOwn(this.actions, operation.action) ? this.actions[operation.action] : this.fallback;
        return adapter?.canReplayBeforeSend?.(operation) === true;
      },
    });
    this.generation = this.lifecycle.recover();
    const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    if (active_task && this.git) {
      this.git.restore(active_task);
    }
  }

  async drain() {
    this.stopping = true;
    this.unsubscribeStore();
    // Shutdown is bounded. A provider stream can hang indefinitely; the
    // operation is already durable and is recovered on the next start, so the
    // daemon must not wait past its stop deadline for that worker.
    await Promise.race([
      Promise.allSettled([...this.pending, ...this.activeGraphs.values()]),
      new Promise<void>(resolve => setTimeout(resolve, 2_000)),
    ]);
  }

  /** After resident transports are closed, finish all kernel writers before closing SQLite. */
  async settleGraphShutdown(): Promise<void> {
    await Promise.allSettled([...this.activeGraphs.values()]);
  }

  /**
   * The token reservation one dispatch of this action needs, looked up exactly the way dispatch itself
   * looks it up (an action with no adapter of its own is served by the fallback). The budget tool asks
   * for it: a cap below this stops that node, and the caller cannot see the number anywhere else.
   */
  reserveTokensFor(action: string | undefined): number | undefined {
    if (!action) return undefined;
    const adapter = Object.hasOwn(this.actions, action) ? this.actions[action] : this.fallback;
    return adapter?.reserveTokens;
  }

  report(id: string, generation: number, result: OperationResult) {
    this.lifecycle.report(id, generation, result);
    if (this.autoWake) this.kick();
  }

  async reconcile(id: string) {
    const work = (async () => {
      const initial = this.lifecycle.get(id);
      if (!initial) throw new RuntimeError('not_found', 'Operation not found');
      if (initial.state !== 'unknown') return;
      const adapter = Object.hasOwn(this.actions, initial.operation.action) ? this.actions[initial.operation.action] : undefined;
      if (!adapter?.reconcile) throw new RuntimeError('reconciliation_unavailable', 'No external reconciliation adapter is registered');
      await this.lifecycle.reconcile(id, operation => adapter.reconcile!(operation));
    })();
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
  }

  /**
   * Soft-stop the live master turn of a task so a pause takes effect after the
   * in-flight tool call rather than as a hard interrupt. Only the conversation
   * master is stopped: an in-flight worker turn is an independent unit that
   * finishes on its own, while new dispatch is blocked by the paused check.
   * Idempotent and best-effort - a failing stop must not fail the pause.
   */
  async stopActiveMasterTurns(taskId: string): Promise<number> {
    const rows = this.store.db.prepare(`SELECT o.id,o.spec FROM operations o
      JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
      WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
        AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid`).all(taskId) as { id: string; spec: string }[];
    let stopped = 0;
    for (const row of rows) {
      const operation = JSON.parse(row.spec) as Operation;
      const adapter = Object.hasOwn(this.actions, operation.action) ? this.actions[operation.action] : this.fallback;
      if (!adapter?.stop) continue;
      try { await adapter.stop(operation); stopped += 1; }
      catch { /* a stop failure must not turn a pause into an error */ }
    }
    return stopped;
  }

  async steer(operationId: string, text: string) {
    return await this.lifecycle.steer(operationId, async operation => {
      // Resolve the adapter exactly like dispatch does: the built-in Agent action
      // has no entry of its own, so it is served by the fallback adapter (the Pi
      // agent), which is also the only one that can steer a running turn.
      const adapter = Object.hasOwn(this.actions, operation.action) ? this.actions[operation.action] : this.fallback;
      if (!adapter?.steer) throw new RuntimeError('steering_unavailable', 'The active Agent does not support steering messages');
      return await adapter.steer(operation, text);
    });
  }

  async interrupt(operationId: string, text?: string) {
    return await this.lifecycle.interrupt(operationId, async operation => {
      const adapter = Object.hasOwn(this.actions, operation.action) ? this.actions[operation.action] : this.fallback;
      if (adapter?.interrupt) return await adapter.interrupt(operation, text);
      // Scripted and legacy adapters expose only the old steering seam. Keep the
      // queue contract intact there; production Pi uses interrupt() for a hard stop.
      if (adapter?.steer && text) return await adapter.steer(operation, text);
      throw new RuntimeError('interrupt_unavailable', 'The active Agent does not support interruption');
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

  /**
   * Operator stop. A task can end up with no path to completion - blocked
   * nodes, failures nobody can answer - and it would keep the single active
   * slot forever, so every queued task of every project waits behind it.
   * Stopping therefore has to hand the slot on, exactly like completion does.
   */
  abandon(taskId: string, reason: string | null, options: { allowMasterTurn?: boolean } = {}) {
    const task = this.store.task(taskId);
    if (['completed', 'abandoned', 'stopped', 'stopping'].includes(task.phase)) throw new RuntimeError('invalid_input', `A ${task.phase} task cannot be abandoned`);
    const kernel = new KernelStore(this.store);
    if (kernel.latestRevision(taskId)) {
      new GraphRuntime(kernel, taskId).stop();
      return this.store.event(taskId, 'task.stop_requested', { reason });
    }
    // The main Agent may stop the task it is serving: its own discussion turn is not
    // integration work, so only a worker lane still writing to the target holds the task
    // open. The user's own abandon keeps the stricter check.
    const busy = options.allowMasterTurn
      ? this.store.db.prepare(`SELECT o.id FROM operations o
          JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
          WHERE o.task_id=? AND o.worker_active=1 AND json_extract(n.spec,'$.role') IS NOT 'master'`).get(taskId)
      : this.store.db.prepare('SELECT id FROM operations WHERE task_id=? AND worker_active=1').get(taskId);
    if (busy) {
      throw new RuntimeError('task_busy', 'Pause the task and wait for its running work to settle before abandoning it');
    }
    // The caller already holds a command transaction, so these writes are
    // atomic with the receipt that records them.
    // The task stops here, so its open problems stop with it: leaving them
    // open would keep the project showing a question nobody can act on.
    const resolved = this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND status='open'")
      .run(canonicalJson({ type: 'abandoned', reason }), taskId);
    this.store.db.prepare("UPDATE tasks SET phase='abandoned' WHERE id=?").run(taskId);
    const cursor = this.store.event(taskId, 'task.abandoned', { reason, resolvedQuestions: resolved.changes });
    releaseTaskSlot(this.store, taskId);
    return cursor;
  }

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
        // §13.8: drain the v2 lane first. A v2 graph has no `nodes` rows, so only this
        // hook can see it; a refused or throwing run must never kill the drive loop.
        dispatched += await this.pumpGraphs();
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
        // pump() may already have started a conversation turn. Completion must
        // drain host-owned work as well as work started by this drive call.
        if (running.size === 0 && this.pending.size === 0 && this.activeGraphs.size === 0) break;
        if (started.length < ready.length) {
          // The execution cap was hit; some operations may now be parked waiting
          // for a credential slot. Re-scan shortly so a node on a free credential
          // is not held behind waiters, which no longer consume execution slots.
          await new Promise(resolve => setTimeout(resolve, 20));
          continue;
        }
        await Promise.race([...running, ...this.pending, ...this.activeGraphs.values(), new Promise<void>(resolve => this.driveWaiters.push(resolve))]);
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
      // §13.8: the v2 lane is drained here too, so a task on the new kernel makes progress
      // on the same host tick as the old path rather than waiting for an explicit call.
      let dispatched = await this.pumpGraphs();
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

  /**
   * Run every v2 graph that currently has queued work. Graphs run one at a time so a
   * rework loop cannot starve another task, and a failure is contained to its own graph:
   * a graph that throws is reported as not drained and the loop moves on.
   */
  private async pumpGraphs(): Promise<number> {
    if (!this.graphs) return 0;
    let dispatched = 0;
    let pending: { taskId: string; run: () => Promise<{ drained: boolean }> }[];
    // A lane that cannot even list its graphs is a real failure, not an idle tick.
    try { pending = this.graphs(); }
    catch (error) { this.reportGraphFailure(null, error); return 0; }
    for (const graph of pending) {
      if (this.stopping || this.dispatchAllowed?.() === false) break;
      if (this.store.task(graph.taskId).paused) continue;
      if (this.activeGraphs.has(graph.taskId)) continue;
      dispatched += 1;
      const work = Promise.resolve().then(() => graph.run())
        .catch(error => this.reportGraphFailure(graph.taskId, error))
        .finally(() => { this.activeGraphs.delete(graph.taskId); this.wakeDrive(); });
      this.activeGraphs.set(graph.taskId, work);
    }
    return dispatched;
  }

  /**
   * Make a graph that could not run visible (HB-272).
   *
   * The host tick fires every 40ms, so a graph that always fails would otherwise repeat
   * its own failure forever, and one that fails once would be indistinguishable from a
   * graph with nothing to do. The reason is recorded once per graph: the first failure is
   * the diagnosis, and a tick that repeats it adds noise, not information.
   */
  private reportGraphFailure(taskId: string | null, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    if (taskId) {
      if (this.store.db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='graph.failed' LIMIT 1").get(taskId)) return;
    }
    try {
      this.store.transaction(() => { this.store.event(taskId, 'graph.failed', { reason }); });
    } catch {
      // Recording must never be the thing that breaks the tick.
    }
  }

  /** Ensure a newly queued message is dispatched even if no drive loop is active. */
  kick() {
    this.sweepWorkcopies();
    if (this.driveActive === 0) void this.drive().catch(() => undefined);
  }

  private sweptAt = 0;

  /** A task that reached a terminal phase must not keep working copies. Best-effort and throttled. */
  private sweepWorkcopies() {
    const now = Date.now();
    if (now - this.sweptAt < 5_000) return;
    this.sweptAt = now;
    try { this.git?.sweepTerminalWorkcopies(); } catch { /* cleanup must never break the drive loop */ }
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
    const chatting = (this.store.db.prepare(`SELECT t.id FROM tasks t
      LEFT JOIN conversations c ON c.id=t.conversation_id
      WHERE t.phase='chatting' AND c.archived_at IS NULL
      ORDER BY t.created_seq`).all() as { id: string }[]).map(row => row.id);
    const { active_task } = this.store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    if (active_task && !chatting.includes(active_task) && this.store.task(active_task).phase !== 'chatting') chatting.push(active_task);
    return chatting;
  }

  /**
   * The external main follows the latest version of its own recipe on its next
   * dispatch. Graph nodes use their explicitly declared frozen recipe instead.
   */
  private refreshDefinition(node: ExecutionNodeRow): ExecutionNodeRow {
    const spec = JSON.parse(node.spec) as NodeSpec;
    const id = spec.definitionVersion?.split('@')[0];
    const latest = id
      ? this.catalog?.listDefinitions().filter(item => item.id === id).sort((left, right) => right.version - left.version)[0]
      : undefined;
    const definitionVersion = latest ? `${id}@${latest.version}` : undefined;
    if (!definitionVersion || definitionVersion === spec.definitionVersion) return node;
    spec.definitionVersion = definitionVersion;
    const specText = canonicalJson(spec);
    this.store.db.prepare('UPDATE nodes SET spec=? WHERE task_id=? AND id=?').run(specText, node.task_id, node.id);
    if (node.instance_id) {
      this.store.db.prepare('UPDATE instances SET definition_version=? WHERE id=?').run(definitionVersion, node.instance_id);
    }
    return { ...node, spec: specText };
  }

  private readyNodes(): ExecutionNodeRow[] {
    if (this.stopping || this.dispatchAllowed?.() === false) return [];
    const nodes: ExecutionNodeRow[] = [];
    for (const taskId of this.laneTasks()) {
      // A pause stops every new dispatch, in full access as well; only the
      // authorization/budget automatic gates stay bypassed there.
      if (this.store.task(taskId).paused) continue;
      nodes.push(...this.readyNodesFor(taskId));
    }
    return nodes;
  }

  private readyNodesFor(taskId: string): ExecutionNodeRow[] {
    const task = this.store.task(taskId);
    if (task.phase === 'chatting') {
      // A chatting master may run for a queued message, an explicit recovery,
      // or a continuation after an answer. Archived conversations never run.
      const conversation = conversationForTask(this.store, taskId);
      if (!conversation || conversation.archived_at !== null) return [];
      const masters = this.store.db.prepare(`SELECT * FROM nodes n
        WHERE n.task_id=? AND n.status='pending' AND json_extract(n.spec,'$.role')='master'
        ORDER BY n.rowid`).all(taskId) as ExecutionNodeRow[];
      return masters.filter(node => !isMasterParked(this.store, taskId, node.id)
        && !(task.paused && pendingRsiContinuation(this.store, taskId, node.id)));
    }
    if (task.phase !== 'discussing') return [];
    return this.store.db.prepare("SELECT * FROM nodes WHERE task_id=? AND status='pending' AND json_extract(spec,'$.role')='master' ORDER BY rowid")
      .all(taskId) as ExecutionNodeRow[];
  }

  private async run(node: ExecutionNodeRow): Promise<boolean> {
    const work = this.execute(node);
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); this.wakeDrive(); }
  }

  private async execute(node: ExecutionNodeRow): Promise<boolean> {
    const accessPolicy = this.access?.() ?? resolveAccessPolicy(standardAccessPolicy());
    const fullAccess = isFullAccess(accessPolicy);
    if (this.stopping || this.dispatchAllowed?.() === false || this.store.task(node.task_id).paused) return false;
    if ((this.store.db.prepare('SELECT status FROM nodes WHERE task_id=? AND id=?').get(node.task_id, node.id) as { status: string }).status !== 'pending') return false;
    if (this.store.task(node.task_id).phase === 'chatting') {
      const conversation = conversationForTask(this.store, node.task_id);
      if (!conversation || conversation.archived_at !== null) return false;
    }
    const spec = JSON.parse(this.refreshDefinition(node).spec) as NodeSpec;
    if (spec.role !== 'master' || spec.kind !== 'agent') throw new RuntimeError('invalid_node', 'External main executor only accepts the main agent');
    const adapter = spec.kind === 'agent'
      ? Object.hasOwn(this.actions, spec.action) ? this.actions[spec.action] : this.fallback
      : undefined;
    if (!adapter || adapter.kind !== spec.kind) {
      this.store.transaction(() => this.block(node, 'adapter_error', { reason: `No ${spec.kind} adapter for ${spec.action}` }));
      return false;
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
    try { workspace = this.git?.workspace(node.task_id, node.instance_id, node.id, spec.kind, spec.action); }
    catch (error) {
      this.store.transaction(() => this.block(node, 'adapter_error', { reason: String(error) }));
      return false;
    }
    let operation: Operation;
    let handoffPackage: ContextHandoffPackage | undefined;
    let conversation: ReturnType<typeof conversationForTask>;
    let chatMessages: ReturnType<typeof pendingMessages> = [];
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
          const rsiContinuation = conversation ? pendingRsiContinuation(this.store, node.task_id, node.id) : undefined;
          const pauseContinuation = conversation ? pendingPauseContinuation(this.store, node.task_id, node.id) : undefined;
          const wakes = conversation ? pendingWakes(this.store, node.task_id, node.id) : [];
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
          const proposal = latest ? JSON.parse(latest.spec) as NativeProposal : undefined;
          const agentContext = spec.kind === 'agent'
            ? resolveAgentContext(this.store, {
                taskId: node.task_id,
                nodeId: node.id,
                spec,
              })
            : undefined;
          const intent: OperationIntent = {
            taskId: node.task_id,
            nodeId: node.id,
            instanceId: node.instance_id,
            kind: spec.kind,
            action: spec.action,
            input: spec.input ?? null,
            dependencies: {},
            proposalVersion: task.accepted_proposal ?? 0,
            requirementVersion: task.requirement_version,
            context: {
              ...(rsiContinuation ? { rsiContinuation } : {}),
              ...(wakes.length ? { wakes } : {}),
              previousOutput: node.output ? JSON.parse(node.output) as Json : null,
              answers,
              ...(messages.length ? { messages } : {}),
              ...(agentContext ? { agentContext } : {}),
            },
            grants,
            accessPolicy,
            activationId: node.activation_id,
            graphVersion: task.graph_version,
            dependencySources: {},
            inputVersions: {},
            ...(workspace ? { workspace } : {}),
          };
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
                },
              } : {}),
            });
          } else {
            intent.context.briefing = briefing(intent, {
              request: task.request,
              ...(proposal?.summary ? { summary: proposal.summary } : {}),
              acceptance: proposal?.acceptance ?? [],
              ...(conversationStatus ? { conversation: conversationStatus } : {}),
              ...(task.decision_digest ? { decisions: task.decision_digest } : {}),
              ...(spec.role === 'master' && this.systemContext ? {
                systemContext: {
                  ...this.systemContext,
                },
              } : {}),
            });
          }
          const outputSchema = { kind: 'agent_result', version: 1 } as const;
          intent.context.outputSchema = outputSchema;
          const userRework = this.store.db.prepare("SELECT text,data FROM node_entries WHERE task_id=? AND node_id=? AND json_extract(data,'$.reworkActivation')=? ORDER BY seq")
            .all(node.task_id, node.id, node.activation_id) as { text: string; data: string | null }[];
          intent.context.briefing = [
            ...userRework.map(message => {
              const from = message.data ? (JSON.parse(message.data) as { from?: string }).from : undefined;
              return from
                ? `Peer Agent ${from} messaged you; treat this as an instruction for this turn and address it in your existing session:\n${message.text}`
                : `User requested rework of this node and its downstream results. Continue in your existing session and address this message:\n${message.text}`;
            }),
            intent.context.briefing,
            conversation && isSummaryLeakRetry(intent.context.previousOutput)
              ? '上一轮输出了内部会话摘要，没有回答用户。请沿用现有会话，完成上一轮用户的原始请求，只给用户正式答复；不要输出 <analysis>、<summary> 或交接摘要。已完成的调查和工具调用无需重复。'
              : '',
            wakes.length ? renderWakes(wakes) : '',
            rsiContinuation ? `RSI reload confirmed for ${rsiContinuation.commit} (request ${rsiContinuation.requestId}). Resume the unfinished user request from operation ${rsiContinuation.operationId} using the existing session. Completed changes and tool results remain valid. Follow any newer user message first; if the goal is already complete, report completion and stop. This is a host continuation, not a new user request.` : '',
            pauseContinuation ? `The user paused this task and has now resumed it (request ${pauseContinuation.requestId}). Continue the exact turn that was soft-stopped at operation ${pauseContinuation.operationId} using the existing session: the in-flight tool call finished, so do not repeat completed tool calls or restart the request. Follow any newer user message first; if the goal is already complete, report completion and stop. This is a host continuation, not a new user request.` : '',
          ].filter(Boolean).join('\n\n');
          if (agentContext) {
            handoffPackage = {
              mode: agentContext.mode,
              purpose: agentContext.purpose,
              independence: agentContext.independence,
              requestedFacts: agentContext.requestedFacts,
              reasonCode: agentContext.reasonCode,
              sourceNodeId: null,
              sourceInstanceId: null,
              sourceSessionId: null,
              sourceLeafId: agentContext.sourceLeafId ?? null,
              summary: proposal?.summary ?? task.request,
              decisions: proposal?.decisions ?? (task.decision_digest ? [task.decision_digest] : []),
              acceptance: proposal?.acceptance ?? [],
              artifactRefs: [],
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
          consumeRsiContinuation(this.store, admitted);
          consumePauseContinuation(this.store, admitted.taskId, admitted.nodeId, admitted.id);
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
              sourceNodeId: null,
            });
            this.store.event(admitted.taskId, 'context.mode_selected', {
              nodeId: admitted.nodeId,
              operationId: admitted.id,
              mode: agentContext.mode,
              reasonCode: agentContext.reasonCode,
              sourceInstanceId: null,
            });
            this.store.event(admitted.taskId, 'context.handoff_frozen', {
              nodeId: admitted.nodeId,
              operationId: admitted.id,
              handoffId: agentContext.handoffId,
              digest: agentContext.handoffDigest,
              constraintsDigest: agentContext.constraintsDigest,
            });

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
            requiredFacts: [] as Json,
            policy: 'none',
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
    const deferredContinuation = operation.context.rsiContinuation && (this.store.task(node.task_id).paused
      || conversationForTask(this.store, node.task_id)?.archived_at !== null);
    if (this.stopping || deferredContinuation || this.dispatchAllowed?.() === false || this.store.task(node.task_id).paused) {
      this.lifecycle.cancelBeforeDispatch(operation.id);
      return false;
    }
    this.lifecycle.dispatch(operation);
    let quiescent = false;
    try {
      const result = await dispatch();
      quiescent = true;
      try {
        this.report(operation.id, operation.generation, result);
      } catch (error) {
        // A refused document is not an uncertain external outcome: the worker
        // finished and we hold its result. Keep the work, record the refusal and
        // hand the defects to whoever owns execution instead of parking the node
        // as unknown and re-running the implementation.
        if (!(error instanceof RuntimeError) || !SUBMISSION_DEFECT_CODES.has(error.code)) throw error;
        this.report(operation.id, operation.generation, {
          ...result, outcome: 'failed',
          output: { error: { code: 'result_noncompliant', reason: error.message }, previousOutput: result.output },
        });
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

}
