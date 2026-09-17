import { randomUUID } from 'node:crypto';
import { closeUserWait, closeUserWaitForOperation, openUserWait } from './time-ledger.ts';
import { isAbsolute } from 'node:path';
import { canonicalJson, type TaskStore } from './store.ts';
import { conversationDigest, conversationForTask, deliverMessages, pendingMessages, recordConversationOutput, releaseMessages } from './conversation.ts';
import { addInstanceBudget, addInstanceUsage, assertWithinBudget, digest, freezeContextHandoff, handoffConstraintsDigest, resolveAgentContext } from './context.ts';
import { loadGraph, reactivate } from './graph.ts';
import { independentReviewReady, implementerModels, isReviewer, pickModel } from './model-selection.ts';
import { graphVerifier, humanCheckNode, workspaceCommandNode } from './program-adapters.ts';
import { settleOperation } from './operation-settlement.ts';
import { recordInterruptedUsage } from './usage-ledger.ts';
import { briefing } from '../catalog/briefing.ts';
import type { Catalog } from '../catalog/catalog.ts';
import type { ModelEntry } from '../catalog/models.ts';
import type { GitIntegration } from '../git/integration.ts';
import { executionLimit, occupiedSlots } from '../runtime/execution-slots.ts';
import { RuntimeError, type ActionAdapter, type Answer, type AttachmentInput, type ContextHandoffPackage, type Json, type NodeSpec, type Operation, type OperationResult, type Proposal, type TokenUsage } from './types.ts';

type NodeRow = { id: string; task_id: string; spec: string; instance_id: string | null; status: string; output: string | null; activation_id: string };
export type OperationRow = { id: string; task_id: string; node_id: string; instance_id: string | null; generation: number; spec: string; state: string; reserved: number; worker_active: number; result: string | null; usage: string | null; activation_id: string };

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
  private readonly autoWake: boolean;
  private readonly generation: number;
  constructor(store: TaskStore, actions: Record<string, ActionAdapter>, extras: { fallback?: ActionAdapter; catalog?: Catalog; models?: () => ModelEntry[]; preferences?: Partial<Record<ModelEntry['grade'], string[]>> | (() => Partial<Record<ModelEntry['grade'], string[]>> | undefined); git?: GitIntegration; scratchRoot?: string; program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string }; autoWake?: boolean; systemContext?: { resources?: boolean; agentCombinations?: boolean; systemSummary?: boolean; requestModelAccess?: boolean } } = {}) {
    this.store = store; this.actions = actions;
    if (extras.fallback) this.fallback = extras.fallback;
    if (extras.catalog) this.catalog = extras.catalog;
    if (extras.models) this.models = extras.models;
    if (extras.preferences) this.preferences = extras.preferences;
    if (extras.git) this.git = extras.git;
    if (extras.scratchRoot) this.scratchRoot = extras.scratchRoot;
    if (extras.program) this.program = extras.program;
    if (extras.systemContext) this.systemContext = extras.systemContext;
    this.autoWake = Boolean(extras.autoWake);
    this.generation = store.transaction(() => {
      store.db.prepare('UPDATE runtime SET generation=generation+1').run();
      const { generation } = store.db.prepare('SELECT generation FROM runtime').get() as { generation: number };
      for (const row of store.db.prepare("SELECT * FROM operations WHERE state IN ('intent','dispatched')").all() as OperationRow[]) {
        if (row.state === 'intent') {
          store.db.prepare("UPDATE operations SET state='not_sent',reserved=0,worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?) WHERE id=?").run(Date.now(), row.id);
          store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(row.task_id, row.node_id);
          store.event(row.task_id, 'operation.not_sent', { operationId: row.id, reason: 'Recovered before dispatch' });
        } else {
          store.db.prepare("UPDATE operations SET state='unknown',waiting_slot=0 WHERE id=?").run(row.id);
          const node = store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(row.task_id, row.node_id) as NodeRow;
          this.block(node, 'recovery', { reason: 'Dispatch was recorded; external outcome and worker liveness require reconciliation' }, row.id);
        }
      }
      return generation;
    });
    const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    if (active_task && this.git) {
      this.git.restore(active_task);
      this.deliver(active_task);
    }
  }

  async drain() { this.stopping = true; await Promise.allSettled([...this.pending]); }

  report(id: string, generation: number, result: OperationResult) {
    let taskId: string | undefined;
    this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationRow | undefined;
      if (!row) throw new RuntimeError('not_found', 'Operation not found');
      if (row.generation !== generation || generation !== this.generation) throw new RuntimeError('stale_generation', 'Worker generation is stale');
      const operation = JSON.parse(row.spec) as Operation;
      taskId = operation.taskId;
      this.settle(operation, result);
    });
    if (taskId) {
      this.deliver(taskId);
      if (this.autoWake) this.kick();
    }
  }

  async reconcile(id: string) {
    const row = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationRow | undefined;
    if (!row) throw new RuntimeError('not_found', 'Operation not found');
    if (row.state !== 'unknown') return;
    const operation = JSON.parse(row.spec) as Operation;
    const adapter = Object.hasOwn(this.actions, operation.action) ? this.actions[operation.action] : undefined;
    if (!adapter?.reconcile) throw new RuntimeError('reconciliation_unavailable', 'No external reconciliation adapter is registered');
    const work = (async () => {
      const evidence = await adapter.reconcile!(operation);
      if (!evidence.proof.trim()) throw new RuntimeError('invalid_reconciliation', 'Reconciliation requires evidence');
      if (evidence.state === 'completed' && this.git && operation.kind === 'agent' && evidence.result.outcome === 'completed') {
        const current = this.store.db.prepare('SELECT state FROM operations WHERE id=?').get(id) as { state: string };
        if (current.state === 'unknown') {
          const merged = await this.git.exclusive(operation.taskId, () => this.git!.integrate(operation));
          if (merged && !merged.ok) throw new RuntimeError('git_conflict', merged.conflicts.join(', '));
        }
      }
      this.store.transaction(() => {
        const current = this.store.db.prepare('SELECT state,result FROM operations WHERE id=?').get(id) as { state: string; result: string | null };
        if (current.state !== 'unknown') return;
        if (evidence.state === 'completed') {
          if (!evidence.quiescent) throw new RuntimeError('invalid_reconciliation', 'Completion must prove the worker is quiescent');
          this.settle(operation, evidence.result);
        } else if (evidence.state === 'not_started') {
          if (!evidence.quiescent || current.result) throw new RuntimeError('invalid_reconciliation', 'Cannot retry an operation with a known result or a live worker');
          this.store.db.prepare("UPDATE operations SET state='not_sent',reserved=0,worker_active=0,settled_at=COALESCE(settled_at,?) WHERE id=?").run(Date.now(), id);
          this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'").run(canonicalJson(evidence), id);
          closeUserWaitForOperation(this.store, id);
          this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(operation.taskId, operation.nodeId);
        } else {
          this.store.db.prepare('UPDATE operations SET worker_active=? WHERE id=?').run(Number(!evidence.quiescent), id);
        }
        this.store.event(operation.taskId, 'operation.reconciled', { operationId: id, evidence });
      });
      this.deliver(operation.taskId);
    })();
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
  }

  async steer(operationId: string, text: string) {
    const row = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId) as OperationRow | undefined;
    if (!row || row.state !== 'dispatched' || !row.worker_active) {
      throw new RuntimeError('no_active_operation', 'The master Agent is no longer accepting steering messages');
    }
    const operation = JSON.parse(row.spec) as Operation;
    const adapter = Object.hasOwn(this.actions, operation.action) ? this.actions[operation.action] : undefined;
    if (!adapter?.steer) throw new RuntimeError('steering_unavailable', 'The active Agent does not support steering messages');
    await adapter.steer(operation, text);
  }

  /** Called only inside the authenticated user command transaction. */
  answer(taskId: string, questionId: string, answer: Answer) {
    const question = this.store.db.prepare('SELECT * FROM questions WHERE id=? AND task_id=?').get(questionId, taskId) as { node_id: string; operation_id: string | null; kind: string; status: string; data: string } | undefined;
    if (!question || question.status !== 'open') throw new RuntimeError('invalid_question', 'No open question in this task');
    if (question.kind === 'budget' && answer.type === 'add_budget') {
      if (!Number.isSafeInteger(answer.tokens) || answer.tokens <= 0) throw new RuntimeError('invalid_answer', 'A positive token increment is required');
      const instance = this.store.db.prepare('SELECT id FROM instances WHERE task_id=? AND node_id=?').get(taskId, question.node_id) as { id: string };
      addInstanceBudget(this.store, instance.id, answer.tokens);
    } else if (question.kind === 'unknown_usage' && answer.type === 'usage') {
      const operation = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(question.operation_id!) as OperationRow;
      if (operation.state === 'interrupted') {
        recordInterruptedUsage(this.store, operation, answer, this.models);
      } else {
        if (!answer.proof.trim() || !operation.result || operation.worker_active) throw new RuntimeError('invalid_answer', 'Usage requires a known result, quiescent worker and evidence');
        this.settle(JSON.parse(operation.spec) as Operation, { ...JSON.parse(operation.result) as OperationResult, usage: answer.usage });
      }
    } else if (question.kind === 'unknown_usage' && answer.type === 'reconcile_usage') {
      // The host reviewed the failed call and the provider exposes no usage for
      // it. The unknown invocation keeps its unknown record, while every known
      // invocation of the same operation is accumulated and the stored result
      // goes through the normal settlement path (output, route, waiting
      // question, budget) exactly once.
      const operation = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(question.operation_id!) as OperationRow;
      if (operation.state === 'interrupted') {
        recordInterruptedUsage(this.store, operation, answer, this.models);
      } else {
      if (!answer.proof.trim() || !operation.result || operation.worker_active) throw new RuntimeError('invalid_answer', 'Reconciliation requires a known result, quiescent worker and proof');
      const known = (this.store.db.prepare('SELECT usage FROM invocations WHERE operation_id=? AND usage IS NOT NULL').all(operation.id) as { usage: string }[])
        .reduce<TokenUsage>((sum, row) => {
          const usage = JSON.parse(row.usage) as TokenUsage;
          return { input: sum.input + usage.input, output: sum.output + usage.output, cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite };
        }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      this.settle(JSON.parse(operation.spec) as Operation, { ...JSON.parse(operation.result) as OperationResult, usage: known });
      this.store.event(taskId, 'operation.usage_reconciled', { operationId: operation.id, decision: 'usage_unavailable', known, proof: answer.proof });
      }
    } else if (question.kind === 'permission' && answer.type === 'grant') {
      if (answer.grant !== (JSON.parse(question.data) as { grant: string }).grant) throw new RuntimeError('invalid_answer', 'Grant must match the requested capability');
      this.store.db.prepare('INSERT OR IGNORE INTO task_grants VALUES(?,?)').run(taskId, answer.grant);
    } else if (!(question.kind === 'waiting' && answer.type === 'respond') && !(['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict', 'context_rejected'].includes(question.kind) && answer.type === 'retry') && !(['reservation_exceeded', 'human_check', 'git_dirty'].includes(question.kind) && answer.type === 'acknowledge') && !(['rework', 'stalled'].includes(question.kind) && (answer.type === 'retry' || answer.type === 'respond'))) {
      throw new RuntimeError('invalid_answer', 'Answer type does not match the open question');
    }
    this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?").run(canonicalJson(answer), questionId);
    closeUserWait(this.store, taskId, question.node_id);
    if (!this.store.db.prepare("SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'").get(taskId, question.node_id)) {
      // Only the current activation's own finished result may lift the node to
      // succeeded. A completed operation from an earlier rework round stays
      // history and must not satisfy the dependency that is still pending.
      const current = this.store.db.prepare("SELECT o.state,o.result FROM operations o JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id WHERE o.task_id=? AND o.node_id=? AND o.activation_id=n.activation_id ORDER BY o.rowid DESC LIMIT 1").get(taskId, question.node_id) as { state: string; result: string | null } | undefined;
      const completed = current?.state === 'succeeded' && current.result !== null && (JSON.parse(current.result) as OperationResult).outcome === 'completed';
      // A conversation master with messages queued during the blocked turn must
      // stay pending: marking it succeeded here would strand the second message
      // after an unknown-usage or budget reconciliation.
      const nodeSpec = JSON.parse((this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(taskId, question.node_id) as { spec: string }).spec) as NodeSpec;
      const conversation = nodeSpec.role === 'master' ? conversationForTask(this.store, taskId) : undefined;
      const queued = conversation ? pendingMessages(this.store, conversation.id, 1).length : 0;
      if (!['rework', 'stalled'].includes(question.kind)) this.store.db.prepare('UPDATE nodes SET status=? WHERE task_id=? AND id=?').run(completed && !queued ? 'succeeded' : 'pending', taskId, question.node_id);
    }
    if (['rework', 'stalled'].includes(question.kind) && (answer.type === 'retry' || answer.type === 'respond')) {
      const resume = (JSON.parse(question.data) as { resume?: string[] }).resume ?? [];
      for (const id of [question.node_id, ...resume]) this.store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(taskId, id);
      if (resume.length) reactivate(this.store, taskId, resume);
    }
    this.advance(taskId);
  }

  finish(taskId: string) { this.deliver(taskId); }

  private block(node: NodeRow, kind: string, data: Json, operationId: string | null = null) {
    this.store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?").run(node.task_id, node.id);
    this.store.db.prepare("UPDATE activations SET state='blocked' WHERE id=?").run(node.activation_id);
    this.store.db.prepare('INSERT INTO questions(id,task_id,node_id,operation_id,kind,data) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), node.task_id, node.id, operationId, kind, canonicalJson(data));
    openUserWait(this.store, node.task_id, node.id);
    this.store.event(node.task_id, 'question.opened', { nodeId: node.id, kind, data, operationId });
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

  private readyNodes(): NodeRow[] {
    if (this.stopping) return [];
    const nodes: NodeRow[] = [];
    for (const taskId of this.laneTasks()) {
      if (this.store.task(taskId).paused) continue;
      nodes.push(...this.readyNodesFor(taskId));
    }
    return nodes;
  }

  private readyNodesFor(taskId: string): NodeRow[] {
    const task = this.store.task(taskId);
    if (task.phase === 'chatting') {
      // Without a confirmed graph the conversation master is the only node that
      // may run; each turn consumes exactly one pending or queued user message.
      return this.store.db.prepare("SELECT * FROM nodes WHERE task_id=? AND status='pending' AND json_extract(spec,'$.role')='master' ORDER BY rowid").all(taskId) as NodeRow[];
    }
    if (task.phase === 'discussing') return this.store.db.prepare("SELECT * FROM nodes WHERE task_id=? AND status='pending' ORDER BY rowid").all(taskId) as NodeRow[];
    if (task.phase !== 'running') return [];
    let nodes: NodeRow[];
    let graph: ReturnType<typeof loadGraph>;
    while (true) {
      nodes = this.store.db.prepare("SELECT * FROM nodes WHERE task_id=? AND status='pending' ORDER BY rowid").all(taskId) as NodeRow[];
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

  private async run(node: NodeRow): Promise<boolean> {
    const work = this.execute(node);
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); this.wakeDrive(); }
  }

  private async execute(node: NodeRow): Promise<boolean> {
    if (this.stopping || this.store.task(node.task_id).paused) return false;
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
      const account = this.store.db.prepare('SELECT models_used FROM instances WHERE id=?').get(node.instance_id) as { models_used: string };
      const usedModels = JSON.parse(account.models_used) as string[];
      if (!usedModels.includes(identity)) this.store.db.prepare('UPDATE instances SET models_used=? WHERE id=?').run(canonicalJson([...usedModels, identity]), node.instance_id);
      if (spec.model && spec.model !== selected.id) this.store.event(node.task_id, 'model.switched', { nodeId: node.id, from: spec.model, to: selected.id, instanceId: node.instance_id });
    }
    const baseGrants = JSON.parse((this.store.db.prepare('SELECT grants FROM projects WHERE id=?').get(this.store.task(node.task_id).project_id) as { grants: string }).grants) as string[];
    const grants = [...new Set([...baseGrants, ...(this.store.db.prepare('SELECT grant FROM task_grants WHERE task_id=?').all(node.task_id) as { grant: string }[]).map(row => row.grant)])];
    const requiredGrant = adapter.grant;
    if (requiredGrant && !grants.includes(requiredGrant)) {
      this.store.transaction(() => this.block(node, 'permission', { grant: requiredGrant }));
      return false;
    }
    if (occupiedSlots(this.store, spec.kind === 'agent' ? 'agent' : 'program') >= executionLimit(spec.kind === 'agent' ? 'agent' : 'program')) return false;
    const reservation = spec.kind === 'agent' ? adapter.reserveTokens : 0;
    if (reservation === undefined || !Number.isSafeInteger(reservation) || reservation < 0) throw new RuntimeError('invalid_adapter', 'A bounded token reservation is required');
    if (node.instance_id) {
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
    try {
      operation = this.store.transaction(() => {
      const task = this.store.task(node.task_id);
      const attempt = (this.store.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE task_id=? AND node_id=?').get(node.task_id, node.id) as { count: number }).count + 1;
      const conversation = task.phase === 'chatting' ? conversationForTask(this.store, node.task_id) : undefined;
      const chatMessages = conversation ? pendingMessages(this.store, conversation.id, 1) : [];
      const graph = task.phase === 'discussing' || task.phase === 'chatting' ? undefined : loadGraph(this.store, node.task_id);
      const dependencies = graph ? graph.inputs(node.id) : {};
      const dependencySources = graph ? graph.sources(node.id) : {};
      const inputVersions = Object.fromEntries(Object.entries(dependencySources).map(([id, sources]) => [id, sources.map(source => ({ activationId: source.activationId, outputVersion: source.outputVersion }))]));
      const answers = (this.store.db.prepare("SELECT id,answer FROM questions WHERE task_id=? AND node_id=? AND kind='waiting' AND status='resolved' ORDER BY rowid").all(node.task_id, node.id) as { id: string; answer: string }[])
        .map(row => ({ questionId: row.id, value: (JSON.parse(row.answer) as { value: Json }).value }));
      const messages = task.phase === 'chatting'
        ? chatMessages.map(message => {
            const data = message.data ? JSON.parse(message.data) as { attachments?: AttachmentInput[] } : null;
            return {
              id: message.id, text: message.text, requirementVersion: task.requirement_version,
              ...(data?.attachments?.length ? { attachments: data.attachments } : {}),
            };
          })
        : (this.store.db.prepare("SELECT data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor").all(node.task_id) as { data: string }[])
          .map(row => JSON.parse(row.data) as { text?: string; request?: string; requirementVersion?: number })
          .map(message => ({ text: message.text ?? message.request!, requirementVersion: message.requirementVersion ?? 1 }));
      const latest = this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(node.task_id, task.latest_proposal) as { spec: string } | undefined;
      const proposal = latest ? JSON.parse(latest.spec) as Proposal : undefined;
      const reviewNode = spec.kind === 'agent' && isReviewer(spec, this.catalog);
      const agentContext = spec.kind === 'agent'
        ? resolveAgentContext(this.store, {
            taskId: node.task_id,
            nodeId: node.id,
            spec,
            review: reviewNode,
            excludedModels: reviewNode ? implementerModels(this.store, spec, node) : [],
          })
        : undefined;
      const operation: Operation = { id: randomUUID(), taskId: node.task_id, nodeId: node.id, instanceId: node.instance_id,
        generation: this.generation, attempt, kind: spec.kind, action: spec.action, input: spec.input ?? null, dependencies,
        proposalVersion: task.accepted_proposal ?? 0, requirementVersion: task.requirement_version,
        context: {
          previousOutput: node.output ? JSON.parse(node.output) as Json : null,
          answers,
          ...(messages.length ? { messages } : {}),
          ...(agentContext ? { agentContext } : {}),
        }, grants,
        activationId: node.activation_id, graphVersion: task.graph_version, dependencySources, inputVersions, ...(workspace ? { workspace } : {}) };
      const graphBriefing = task.accepted_proposal !== null && spec.kind === 'agent'
        ? [...loadGraph(this.store, node.task_id).plan.nodes.values()]
        : undefined;
      const verifier = graphBriefing?.find(candidate => candidate.action === 'graph.verify' && candidate.verifier?.reportNodes.includes(spec.id));
      const review = verifier?.verifier ? [{ kind: verifier.verifier.kind }] : undefined;
      const conversationStatus = conversation ? conversationDigest(this.store, conversation.id) : undefined;
      if (this.catalog) {
        let capabilities: { id: string; version: string }[] | undefined;
        if (spec.definitionVersion) {
          try { capabilities = this.catalog.definition(spec.definitionVersion).capabilities; }
          catch { /* unpublished definitions still get a request briefing */ }
        }
        operation.context.briefing = briefing(operation, {
          request: task.request, ...(proposal?.summary ? { summary: proposal.summary } : {}),
          acceptance: proposal?.acceptance ?? [],
          ...(capabilities?.length ? { capabilities } : {}),
          ...(graphBriefing?.length ? { graph: graphBriefing } : {}),
          ...(review ? { review } : {}),
          ...(conversationStatus ? { conversation: conversationStatus } : {}),
          ...(task.decision_digest ? { decisions: task.decision_digest } : {}),
          ...(spec.role === 'master' ? { catalog: {
            definitions: this.catalog.listDefinitions().map(item => `${item.id}@${item.version}`),
          }, systemContext: {
            ...this.systemContext,
            requestModelAccess: Boolean(conversation && spec.role === 'master' && this.systemContext?.requestModelAccess),
          } } : {}),
        });
      } else {
        operation.context.briefing = briefing(operation, {
          request: task.request, ...(proposal?.summary ? { summary: proposal.summary } : {}),
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
      if (agentContext) {
        if (reviewNode && (agentContext.mode !== 'fresh' || !agentContext.reviewPolicy
          || !agentContext.reviewPolicy.freshRequired || !agentContext.reviewPolicy.evidenceOnly)) {
          throw new RuntimeError('context_rejected', 'Independent review requires a fresh evidence-only handoff');
        }
        const artifactRefs = Object.values(dependencySources).flatMap(sources =>
          sources.flatMap(source => source.artifacts.map(artifact => ({ path: artifact.path, digest: artifact.digest }))));
        const handoffPackage: ContextHandoffPackage = {
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
          outputSchema: reviewNode ? { kind: 'independent_review', version: 1 } : { kind: 'agent_result', version: 1 },
          briefing: operation.context.briefing ?? '',
        };
        const handoffDigest = digest(handoffPackage);
        const constraintsDigest = handoffConstraintsDigest(handoffPackage);
        operation.context.agentContext = { ...agentContext, handoffDigest, constraintsDigest };
        this.store.db.prepare("INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id) VALUES(?,?,?,?,?,?,'intent',?,?)")
          .run(operation.id, node.task_id, node.id, node.instance_id, operation.generation, canonicalJson(operation), reservation, node.activation_id);
        freezeContextHandoff(this.store, operation.context.agentContext, {
          taskId: node.task_id,
          operationId: operation.id,
          nodeId: node.id,
          instanceId: node.instance_id!,
          package: handoffPackage,
        });
        this.store.event(node.task_id, 'context.requested', {
          nodeId: node.id,
          operationId: operation.id,
          purpose: agentContext.purpose,
          independence: agentContext.independence,
          sourceNodeId: agentContext.sourceNodeId ?? null,
        });
        this.store.event(node.task_id, 'context.mode_selected', {
          nodeId: node.id,
          operationId: operation.id,
          mode: agentContext.mode,
          reasonCode: agentContext.reasonCode,
          sourceInstanceId: agentContext.sourceInstanceId ?? null,
        });
        this.store.event(node.task_id, 'context.handoff_frozen', {
          nodeId: node.id,
          operationId: operation.id,
          handoffId: agentContext.handoffId,
          digest: handoffDigest,
          constraintsDigest,
        });
        if (reviewNode) {
          const policyDigest = digest(agentContext.reviewPolicy!);
          this.store.event(node.task_id, 'review.independence_checked', {
            nodeId: node.id,
            operationId: operation.id,
            handoffDigest,
            constraintsDigest,
            transcriptIncluded: false,
            independence: agentContext.independence,
            policy: agentContext.reviewPolicy,
            policyDigest,
          });
        }
      } else {
        this.store.db.prepare("INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id) VALUES(?,?,?,?,?,?,'intent',?,?)")
          .run(operation.id, node.task_id, node.id, node.instance_id, operation.generation, canonicalJson(operation), reservation, node.activation_id);
      }
      if (conversation && chatMessages.length) {
        // Consuming the queue in the same transaction as the operation makes
        // the binding durable before any provider send can happen. The state
        // change is published so a browser cache that no longer holds these
        // records in its latest window still updates from pending to delivered.
        // MAX(?, updated_at+1) keeps every state transition strictly newer
        // than the previous record even when two changes land in the same
        // millisecond, so incremental caches can order them reliably.
        deliverMessages(this.store, operation.id, attempt, chatMessages);
      }
      this.store.db.prepare("UPDATE activations SET input_versions=?,state='preparing' WHERE id=?").run(canonicalJson(inputVersions), node.activation_id);
      this.store.db.prepare("UPDATE nodes SET status='preparing' WHERE task_id=? AND id=?").run(node.task_id, node.id);
      this.store.event(node.task_id, 'operation.intent', operation);
      return operation;
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
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE operations SET state='not_sent',reserved=0,settled_at=COALESCE(settled_at,?) WHERE id=?").run(Date.now(), operation.id);
        releaseMessages(this.store, operation.id);
        this.block(node, 'adapter_error', { reason: String(error) }, operation.id);
      });
      return false;
    }
    if (this.stopping || this.store.task(node.task_id).paused) {
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE operations SET state='not_sent',reserved=0,settled_at=COALESCE(settled_at,?) WHERE id=?").run(Date.now(), operation.id);
        this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(node.task_id, node.id);
        releaseMessages(this.store, operation.id);
        this.store.event(node.task_id, 'operation.not_sent', { operationId: operation.id });
      });
      return false;
    }
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE operations SET state='dispatched',worker_active=1,dispatched_at=COALESCE(dispatched_at,?) WHERE id=?").run(Date.now(), operation.id);
      this.store.db.prepare("UPDATE nodes SET status='running' WHERE task_id=? AND id=?").run(node.task_id, node.id);
      this.store.db.prepare("UPDATE activations SET state='running' WHERE id=?").run(node.activation_id);
      this.store.event(node.task_id, 'operation.dispatched', { operationId: operation.id });
    });
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
      this.report(operation.id, operation.generation, result);
    } catch (error) {
      // A gate refusal means the refused send never happened. With no prior
      // provider request the operation is not_sent; after partial work it is
      // interrupted with its known usage accounted once and its session kept,
      // so the node can resume on the same instance. Neither case advances the
      // graph or hides the worker state.
      const refusal = error instanceof RuntimeError ? error : undefined;
      const refusalCode = refusal?.code;
      if (refusal && refusalCode && ['paused', 'budget', 'unknown_usage', 'context_rejected'].includes(refusalCode)) {
        const handled = this.store.transaction(() => {
          const current = this.store.db.prepare('SELECT state FROM operations WHERE id=?').get(operation.id) as { state: string };
          if (!['dispatched', 'unknown'].includes(current.state)) return false;
          const invocations = this.store.db.prepare('SELECT usage FROM invocations WHERE operation_id=?').all(operation.id) as { usage: string | null }[];
          const known = invocations.map(row => row.usage ? JSON.parse(row.usage) as TokenUsage : null);
          const unknown = known.some(value => value === null);
          const total = known.reduce((sum, value) => sum + (value ? value.input + value.output + value.cacheRead + value.cacheWrite : 0), 0);
          const state = invocations.length ? 'interrupted' : 'not_sent';
          this.store.db.prepare('UPDATE operations SET state=?,reserved=0,worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?) WHERE id=?').run(state, Date.now(), operation.id);
          if (state === 'interrupted') {
            if (!unknown && total > 0 && operation.instanceId) {
              addInstanceUsage(this.store, operation.instanceId, total);
              const account = this.store.db.prepare('SELECT model,models_used FROM instances WHERE id=?').get(operation.instanceId) as { model: string | null; models_used: string };
              const usedModels = JSON.parse(account.models_used) as string[];
              if (account.model && !usedModels.includes(account.model)) this.store.db.prepare('UPDATE instances SET models_used=? WHERE id=?').run(canonicalJson([...usedModels, account.model]), operation.instanceId);
            }
            this.store.event(node.task_id, 'operation.interrupted', { operationId: operation.id, reason: refusal.message, usage: unknown ? null : total, invocations: invocations.length });
          } else {
            releaseMessages(this.store, operation.id);
            this.store.event(node.task_id, 'operation.not_sent', { operationId: operation.id, reason: refusal.message });
          }
          if (refusalCode === 'budget') this.block(node, 'budget', { reason: refusal.message, requested: reservation });
          else if (refusalCode === 'context_rejected') {
            const data = {
              reason: refusal.message,
              code: refusalCode,
              requiredFacts: (spec.context?.requiredFacts ?? []) as unknown as Json,
              policy: spec.context?.independence ?? 'none',
            };
            this.store.event(node.task_id, 'context.rejected', { nodeId: node.id, operationId: operation.id, ...data });
            this.block(node, 'context_rejected', data, operation.id);
          }
          else if (unknown || refusalCode === 'unknown_usage') {
            // The gate already recorded the unknown-usage question for this operation.
            const existing = this.store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'").get(operation.id) as { id: string } | undefined;
            if (existing) this.store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?").run(node.task_id, node.id);
            else this.block(node, 'unknown_usage', { reason: refusal.message });
          } else {
            this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(node.task_id, node.id);
          }
          return true;
        });
        if (handled) return false;
      }
      this.store.transaction(() => {
        const current = this.store.db.prepare('SELECT state FROM operations WHERE id=?').get(operation.id) as { state: string };
        if (!['dispatched', 'unknown'].includes(current.state)) {
          this.store.event(node.task_id, 'operation.report_rejected', { operationId: operation.id, reason: String(error) });
          return;
        }
        this.store.db.prepare("UPDATE operations SET state='unknown',worker_active=? WHERE id=?").run(Number(!quiescent), operation.id);
        this.block(node, 'recovery', { reason: String(error) }, operation.id);
      });
    }
    return true;
  }

  private settle(operation: Operation, result: OperationResult) {
    settleOperation(this.store, operation, result, {
      block: (node, kind, data, operationId) => this.block(node, kind, data, operationId),
      advance: taskId => this.advance(taskId),
    });
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
          const node = this.store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(taskId, proposal.acceptance[0]!.checkNode) as NodeRow;
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
