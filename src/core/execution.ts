import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { realpath, symlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalJson, type TaskStore } from './store.ts';
import { appendMessage, conversationDigest, conversationForTask, pendingMessages, publishMessageUpdate, releaseMessages } from './conversation.ts';
import { loadGraph, reactivate } from './graph.ts';
import { evaluateVerifier, isReworkDecision, type VerificationDecision } from './verification.ts';
import { briefing } from '../catalog/briefing.ts';
import type { Catalog } from '../catalog/catalog.ts';
import { estimateCost, selectModel, type ModelEntry } from '../catalog/models.ts';
import type { GitIntegration } from '../git/integration.ts';
import { openWorkspaceCommandRunner, validateWorkspaceCommand } from '../runtime/workspace-command.ts';
import { executionLimit, occupiedSlots } from '../runtime/execution-slots.ts';
import type { RestrictedGate } from '../runtime/restricted-process.ts';
import { RuntimeError, type ActionAdapter, type Answer, type Json, type NodeSpec, type Operation, type OperationResult, type Proposal, type TokenUsage } from './types.ts';

type NodeRow = { id: string; task_id: string; spec: string; instance_id: string | null; status: string; output: string | null; activation_id: string };
export type OperationRow = { id: string; task_id: string; node_id: string; instance_id: string | null; generation: number; spec: string; state: string; reserved: number; worker_active: number; result: string | null; usage: string | null; activation_id: string };

/** Private execution state machine. Every mutation shares the task command/event transaction. */
export class Execution {
  private readonly pending = new Set<Promise<unknown>>();
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
  private readonly generation: number;
  constructor(store: TaskStore, actions: Record<string, ActionAdapter>, extras: { fallback?: ActionAdapter; catalog?: Catalog; models?: () => ModelEntry[]; preferences?: Partial<Record<ModelEntry['grade'], string[]>> | (() => Partial<Record<ModelEntry['grade'], string[]>> | undefined); git?: GitIntegration; scratchRoot?: string; program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string } } = {}) {
    this.store = store; this.actions = actions;
    if (extras.fallback) this.fallback = extras.fallback;
    if (extras.catalog) this.catalog = extras.catalog;
    if (extras.models) this.models = extras.models;
    if (extras.preferences) this.preferences = extras.preferences;
    if (extras.git) this.git = extras.git;
    if (extras.scratchRoot) this.scratchRoot = extras.scratchRoot;
    if (extras.program) this.program = extras.program;
    this.generation = store.transaction(() => {
      store.db.prepare('UPDATE runtime SET generation=generation+1').run();
      const { generation } = store.db.prepare('SELECT generation FROM runtime').get() as { generation: number };
      for (const row of store.db.prepare("SELECT * FROM operations WHERE state IN ('intent','dispatched')").all() as OperationRow[]) {
        if (row.state === 'intent') {
          store.db.prepare("UPDATE operations SET state='not_sent',reserved=0,worker_active=0,waiting_slot=0 WHERE id=?").run(row.id);
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
    if (taskId) this.deliver(taskId);
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
          this.store.db.prepare("UPDATE operations SET state='not_sent',reserved=0,worker_active=0 WHERE id=?").run(id);
          this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'").run(canonicalJson(evidence), id);
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

  /** Release an interrupted operation's unknown usage through the
   * authenticated answer path. Recording fills the single unknown invocation;
   * keeping it unknown leaves that record and applies only the known part.
   * The operation stays interrupted, so the node can continue on its session
   * once the question is resolved. */
  private recordInterruptedUsage(operation: OperationRow, answer: { type: 'usage'; usage: TokenUsage; proof: string } | { type: 'reconcile_usage'; proof: string }) {
    if (!answer.proof.trim()) throw new RuntimeError('invalid_answer', 'Evidence is required to release unknown usage');
    if (operation.result || operation.worker_active) throw new RuntimeError('invalid_answer', 'Interrupted usage reconciliation requires a quiescent operation without a result');
    if (answer.type === 'usage') {
      const unknown = this.store.db.prepare('SELECT id FROM invocations WHERE operation_id=? AND usage IS NULL').all(operation.id) as { id: string }[];
      if (unknown.length !== 1) throw new RuntimeError('invalid_answer', 'Recording authoritative usage requires exactly one unknown invocation');
      const values = [answer.usage.input, answer.usage.output, answer.usage.cacheRead, answer.usage.cacheWrite];
      const total = values.reduce((sum, value) => sum + value, 0);
      if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(total)) throw new RuntimeError('invalid_usage', 'Invalid disjoint token counts');
      const instance = operation.instance_id
        ? this.store.db.prepare('SELECT model FROM instances WHERE id=?').get(operation.instance_id) as { model: string | null }
        : undefined;
      const entry = instance?.model ? this.models?.().find(model => model.id === instance.model) : undefined;
      this.store.db.prepare('UPDATE invocations SET usage=?,cost=? WHERE id=?')
        .run(canonicalJson(answer.usage), canonicalJson(estimateCost(answer.usage, entry?.cost, entry?.pricing)), unknown[0]!.id);
    }
    const known = (this.store.db.prepare('SELECT usage FROM invocations WHERE operation_id=? AND usage IS NOT NULL').all(operation.id) as { usage: string }[])
      .reduce<TokenUsage>((sum, row) => {
        const usage = JSON.parse(row.usage) as TokenUsage;
        return { input: sum.input + usage.input, output: sum.output + usage.output, cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite };
      }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const total = known.input + known.output + known.cacheRead + known.cacheWrite;
    if (total > 0 && operation.instance_id) {
      this.store.db.prepare('UPDATE instances SET used=used+? WHERE id=?').run(total, operation.instance_id);
      const account = this.store.db.prepare('SELECT model,models_used FROM instances WHERE id=?').get(operation.instance_id) as { model: string | null; models_used: string };
      const usedModels = JSON.parse(account.models_used) as string[];
      if (account.model && !usedModels.includes(account.model)) this.store.db.prepare('UPDATE instances SET models_used=? WHERE id=?').run(canonicalJson([...usedModels, account.model]), operation.instance_id);
    }
    this.store.event(operation.task_id, 'operation.usage_reconciled', {
      operationId: operation.id, decision: answer.type === 'usage' ? 'recorded' : 'usage_unavailable', known, proof: answer.proof,
    });
  }

  /** Called only inside the authenticated user command transaction. */
  answer(taskId: string, questionId: string, answer: Answer) {
    const question = this.store.db.prepare('SELECT * FROM questions WHERE id=? AND task_id=?').get(questionId, taskId) as { node_id: string; operation_id: string | null; kind: string; status: string; data: string } | undefined;
    if (!question || question.status !== 'open') throw new RuntimeError('invalid_question', 'No open question in this task');
    if (question.kind === 'budget' && answer.type === 'add_budget') {
      if (!Number.isSafeInteger(answer.tokens) || answer.tokens <= 0) throw new RuntimeError('invalid_answer', 'A positive token increment is required');
      const instance = this.store.db.prepare('SELECT id,budget,unlimited FROM instances WHERE task_id=? AND node_id=?').get(taskId, question.node_id) as { id: string; budget: number; unlimited: number };
      if (instance.unlimited) throw new RuntimeError('invalid_answer', 'An unlimited instance has no budget question to add to');
      if (!Number.isSafeInteger(instance.budget + answer.tokens)) throw new RuntimeError('invalid_answer', 'Budget exceeds the supported range');
      this.store.db.prepare('UPDATE instances SET budget=budget+? WHERE id=?').run(answer.tokens, instance.id);
    } else if (question.kind === 'unknown_usage' && answer.type === 'usage') {
      const operation = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(question.operation_id!) as OperationRow;
      if (operation.state === 'interrupted') {
        this.recordInterruptedUsage(operation, answer);
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
        this.recordInterruptedUsage(operation, answer);
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
    } else if (!(question.kind === 'waiting' && answer.type === 'respond') && !(['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict'].includes(question.kind) && answer.type === 'retry') && !(['reservation_exceeded', 'human_check', 'git_dirty'].includes(question.kind) && answer.type === 'acknowledge') && !(['rework', 'stalled'].includes(question.kind) && (answer.type === 'retry' || answer.type === 'respond'))) {
      throw new RuntimeError('invalid_answer', 'Answer type does not match the open question');
    }
    this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?").run(canonicalJson(answer), questionId);
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
      // may run; one pending turn answers every message queued so far.
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

  private pickModel(spec: NodeSpec, node: NodeRow) {
    if (!this.models) return;
    const directory = this.models();
    let definition: { recommendedGrade: ModelEntry['grade']; review?: boolean } = { recommendedGrade: 'medium' };
    if (spec.definitionVersion && this.catalog) {
      try { definition = this.catalog.definition(spec.definitionVersion); } catch { /* unpublished keys still select by requested model */ }
    }
    const exclude = definition.review ? this.implementerModels(spec, node) : [];
    const preferences = typeof this.preferences === 'function' ? this.preferences() : this.preferences;
    return selectModel({ ...(spec.model ? { requested: spec.model } : {}), grade: definition.recommendedGrade, directory, ...(preferences ? { preferences } : {}), ...(exclude.length ? { exclude } : {}) });
  }

  private implementerModels(spec: NodeSpec, node: NodeRow) {
    const graph = loadGraph(this.store, node.task_id);
    const models: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (graph.plan.containers.has(id)) {
        for (const leaf of graph.plan.leaves(id)) walk(leaf);
        return;
      }
      const target = graph.plan.nodes.get(id);
      if (!target) return;
      if (target.kind === 'agent') {
        const row = this.store.db.prepare('SELECT models_used FROM instances WHERE task_id=? AND node_id=?').get(node.task_id, id) as { models_used: string } | undefined;
        if (row) models.push(...JSON.parse(row.models_used) as string[]);
        return;
      }
      for (const dependency of graph.plan.dependencies.get(id) ?? []) walk(dependency);
    };
    for (const dependency of spec.dependsOn ?? []) walk(dependency);
    return [...new Set(models)];
  }

  private isReviewer(spec: NodeSpec) {
    if (!spec.definitionVersion || !this.catalog) return false;
    try { return this.catalog.definition(spec.definitionVersion).review === true; }
    catch { return false; }
  }

  private independentReviewReady(taskId: string) {
    const graph = loadGraph(this.store, taskId);
    const reviewers = [...graph.plan.nodes.values()].filter(spec => spec.kind === 'agent' && this.isReviewer(spec));
    if (!reviewers.length) return false;
    for (const spec of graph.plan.nodes.values()) {
      if (spec.action !== 'graph.verify' || !spec.verifier) continue;
      if (!spec.verifier.reportNodes.some(id => reviewers.some(reviewer => reviewer.id === id))) continue;
      if (graph.status(spec.id) !== 'succeeded') continue;
      const output = graph.output(spec.id);
      if (output && typeof output === 'object' && !Array.isArray(output) && output.kind === 'verification' && output.outcome === 'pass') return true;
    }
    return false;
  }

  private graphVerify(spec: NodeSpec): ActionAdapter {
    return {
      kind: 'program',
      prepare: async operation => async () => {
        if (!spec.verifier) throw new RuntimeError('invalid_adapter', 'graph.verify requires a verifier config');
        const proposal = JSON.parse((this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(operation.taskId, operation.proposalVersion) as { spec: string }).spec) as Proposal;
        const acceptanceIds = proposal.acceptance.filter(item => item.checkNode === operation.nodeId).map(item => item.id);
        try {
          return evaluateVerifier(spec.verifier, { dependencies: operation.dependencies, dependencySources: operation.dependencySources, acceptanceIds });
        } catch (error) {
          if (error instanceof RuntimeError && error.code === 'invalid_evidence') {
            return { outcome: 'completed', output: { kind: 'verification', outcome: 'rework', subjects: [], reports: [], blockers: [{ id: 'invalid_evidence', reason: error.message, evidence: [] }] } };
          }
          throw error;
        }
      },
    };
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
    const adapter = spec.action === 'graph.verify' ? this.graphVerify(spec) : spec.action === 'graph.human_check' ? this.humanCheck() : spec.action === 'graph.command' ? this.commandNode(spec) : Object.hasOwn(this.actions, spec.action) ? this.actions[spec.action] : spec.kind === 'agent' ? this.fallback : undefined;
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
      const selected = this.pickModel(spec, node);
      if (!selected) {
        this.store.transaction(() => this.block(node, 'model_unavailable', { requested: spec.model ?? null }));
        return false;
      }
      this.store.db.prepare('UPDATE instances SET model=?,definition_version=? WHERE id=?').run(selected.id, spec.definitionVersion ?? null, node.instance_id);
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
      const account = this.store.db.prepare('SELECT budget,used,unlimited FROM instances WHERE id=?').get(node.instance_id) as { budget: number; used: number; unlimited: number };
      const { reserved } = this.store.db.prepare('SELECT COALESCE(SUM(reserved),0) AS reserved FROM operations WHERE instance_id=?').get(node.instance_id) as { reserved: number };
      if (!account.unlimited && (account.used >= account.budget || account.used + reserved + reservation > account.budget)) {
        this.store.transaction(() => this.block(node, 'budget', { budget: account.budget, used: account.used, reserved, requested: reservation }));
        return false;
      }
    }
    let workspace: string | undefined;
    try { workspace = this.git?.workspace(node.task_id, node.instance_id, node.id, spec.kind); }
    catch (error) {
      this.store.transaction(() => this.block(node, 'adapter_error', { reason: String(error) }));
      return false;
    }
    const operation = this.store.transaction(() => {
      const task = this.store.task(node.task_id);
      const attempt = (this.store.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE task_id=? AND node_id=?').get(node.task_id, node.id) as { count: number }).count + 1;
      const conversation = task.phase === 'chatting' ? conversationForTask(this.store, node.task_id) : undefined;
      const chatMessages = conversation ? pendingMessages(this.store, conversation.id) : [];
      const graph = task.phase === 'discussing' || task.phase === 'chatting' ? undefined : loadGraph(this.store, node.task_id);
      const dependencies = graph ? graph.inputs(node.id) : {};
      const dependencySources = graph ? graph.sources(node.id) : {};
      const inputVersions = Object.fromEntries(Object.entries(dependencySources).map(([id, sources]) => [id, sources.map(source => ({ activationId: source.activationId, outputVersion: source.outputVersion }))]));
      const answers = (this.store.db.prepare("SELECT id,answer FROM questions WHERE task_id=? AND node_id=? AND kind='waiting' AND status='resolved' ORDER BY rowid").all(node.task_id, node.id) as { id: string; answer: string }[])
        .map(row => ({ questionId: row.id, value: (JSON.parse(row.answer) as { value: Json }).value }));
      const messages = task.phase === 'chatting'
        ? chatMessages.map(message => ({ id: message.id, text: message.text, requirementVersion: task.requirement_version }))
        : (this.store.db.prepare("SELECT data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor").all(node.task_id) as { data: string }[])
          .map(row => JSON.parse(row.data) as { text?: string; request?: string; requirementVersion?: number })
          .map(message => ({ text: message.text ?? message.request!, requirementVersion: message.requirementVersion ?? 1 }));
      const latest = this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(node.task_id, task.latest_proposal) as { spec: string } | undefined;
      const proposal = latest ? JSON.parse(latest.spec) as Proposal : undefined;
      const operation: Operation = { id: randomUUID(), taskId: node.task_id, nodeId: node.id, instanceId: node.instance_id,
        generation: this.generation, attempt, kind: spec.kind, action: spec.action, input: spec.input ?? null, dependencies,
        proposalVersion: task.accepted_proposal ?? 0, requirementVersion: task.requirement_version,
        context: { previousOutput: node.output ? JSON.parse(node.output) as Json : null, answers, ...(messages.length ? { messages } : {}) }, grants,
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
            capabilities: this.catalog.capabilities().map(item => `${item.id}@${item.version}`),
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
        });
      }
      this.store.db.prepare("INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id) VALUES(?,?,?,?,?,?,'intent',?,?)")
        .run(operation.id, node.task_id, node.id, node.instance_id, operation.generation, canonicalJson(operation), reservation, node.activation_id);
      if (conversation && chatMessages.length) {
        // Consuming the queue in the same transaction as the operation makes
        // the binding durable before any provider send can happen. The state
        // change is published so a browser cache that no longer holds these
        // records in its latest window still updates from pending to delivered.
        // MAX(?, updated_at+1) keeps every state transition strictly newer
        // than the previous record even when two changes land in the same
        // millisecond, so incremental caches can order them reliably.
        this.store.db.prepare(`UPDATE messages SET state='delivered',operation_id=?,turn=?,updated_at=MAX(?,updated_at+1) WHERE id IN (${chatMessages.map(() => '?').join(',')})`)
          .run(operation.id, attempt, Date.now(), ...chatMessages.map(message => message.id));
        for (const message of chatMessages) publishMessageUpdate(this.store, message.id);
      }
      this.store.db.prepare("UPDATE activations SET input_versions=?,state='preparing' WHERE id=?").run(canonicalJson(inputVersions), node.activation_id);
      this.store.db.prepare("UPDATE nodes SET status='preparing' WHERE task_id=? AND id=?").run(node.task_id, node.id);
      this.store.event(node.task_id, 'operation.intent', operation);
      return operation;
    });
    let dispatch: () => Promise<OperationResult>;
    try {
      dispatch = await adapter.prepare(operation);
      if (typeof dispatch !== 'function') throw new RuntimeError('invalid_adapter', 'prepare must return a dispatch callback');
    } catch (error) {
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE operations SET state='not_sent',reserved=0 WHERE id=?").run(operation.id);
        releaseMessages(this.store, operation.id);
        this.block(node, 'adapter_error', { reason: String(error) }, operation.id);
      });
      return false;
    }
    if (this.stopping || this.store.task(node.task_id).paused) {
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE operations SET state='not_sent',reserved=0 WHERE id=?").run(operation.id);
        this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(node.task_id, node.id);
        releaseMessages(this.store, operation.id);
        this.store.event(node.task_id, 'operation.not_sent', { operationId: operation.id });
      });
      return false;
    }
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE operations SET state='dispatched',worker_active=1 WHERE id=?").run(operation.id);
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
      if (refusal && refusalCode && ['paused', 'budget', 'unknown_usage'].includes(refusalCode)) {
        const handled = this.store.transaction(() => {
          const current = this.store.db.prepare('SELECT state FROM operations WHERE id=?').get(operation.id) as { state: string };
          if (!['dispatched', 'unknown'].includes(current.state)) return false;
          const invocations = this.store.db.prepare('SELECT usage FROM invocations WHERE operation_id=?').all(operation.id) as { usage: string | null }[];
          const known = invocations.map(row => row.usage ? JSON.parse(row.usage) as TokenUsage : null);
          const unknown = known.some(value => value === null);
          const total = known.reduce((sum, value) => sum + (value ? value.input + value.output + value.cacheRead + value.cacheWrite : 0), 0);
          const state = invocations.length ? 'interrupted' : 'not_sent';
          this.store.db.prepare('UPDATE operations SET state=?,reserved=0,worker_active=0,waiting_slot=0 WHERE id=?').run(state, operation.id);
          if (state === 'interrupted') {
            if (!unknown && total > 0 && operation.instanceId) {
              this.store.db.prepare('UPDATE instances SET used=used+? WHERE id=?').run(total, operation.instanceId);
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

  /** Persist the durable side of a master turn: one assistant message plus
   * summarized tool activity. Idempotent per operation so reconciliation and
   * unknown-usage settlement cannot duplicate the record. */
  private recordConversationOutput(operation: Operation, result: OperationResult) {
    if (operation.kind !== 'agent') return;
    const nodeSpec = JSON.parse((this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
    if (nodeSpec.role !== 'master') return;
    const conversation = conversationForTask(this.store, operation.taskId);
    if (!conversation) return;
    if (this.store.db.prepare("SELECT id FROM messages WHERE operation_id=? AND role='assistant' LIMIT 1").get(operation.id)) return;
    const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output) ? result.output as { [key: string]: Json } : undefined;
    if (result.outcome === 'completed') {
      const reply = typeof output?.text === 'string' ? output.text.trim() : '';
      if (reply) appendMessage(this.store, { conversationId: conversation.id, role: 'assistant', kind: 'chat', text: reply, state: 'done', operationId: operation.id, turn: operation.attempt });
      const activity = Array.isArray(output?.toolActivity) ? output.toolActivity : [];
      for (const item of activity) {
        const entry = item as { name?: unknown; summary?: unknown; state?: unknown; toolCallId?: unknown };
        if (typeof entry.summary !== 'string' || !entry.summary.trim()) continue;
        appendMessage(this.store, {
          conversationId: conversation.id, role: 'tool', kind: 'tool',
          text: typeof entry.name === 'string' ? `${entry.name}: ${entry.summary}` : entry.summary,
          data: { tool: typeof entry.name === 'string' ? entry.name : 'tool', ...(typeof entry.toolCallId === 'string' ? { toolCallId: entry.toolCallId } : {}), ...(entry.state === 'error' ? { error: true } : {}) },
          state: 'done', operationId: operation.id, turn: operation.attempt,
        });
      }
    } else if (result.outcome === 'failed') {
      const reason = output && 'error' in output ? JSON.stringify(output.error) : JSON.stringify(result.output);
      appendMessage(this.store, { conversationId: conversation.id, role: 'system', kind: 'error', text: `主 Agent 本轮未完成：${(reason ?? '').slice(0, 500)}`, state: 'done', operationId: operation.id, turn: operation.attempt });
    }
  }

  private settle(operation: Operation, result: OperationResult) {
    if (!result || !['completed', 'continue', 'waiting', 'failed', 'skipped'].includes(result.outcome)) throw new RuntimeError('invalid_result', 'Unexpected operation outcome');
    canonicalJson(result);
    const row = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(operation.id) as OperationRow;
    if (row.state === 'succeeded') {
      if (row.result !== canonicalJson(result)) throw new RuntimeError('result_conflict', 'Operation already has a different result');
      return;
    }
    if (!['dispatched', 'unknown'].includes(row.state)) throw new RuntimeError('invalid_operation', 'Operation was not dispatched');
    const currentNode = this.store.db.prepare('SELECT activation_id FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as { activation_id: string };
    if (currentNode.activation_id !== operation.activationId) throw new RuntimeError('stale_activation', 'Operation belongs to a replaced activation');
    if (row.result) {
      const previous = JSON.parse(row.result) as OperationResult;
      if (canonicalJson({ ...previous, usage: undefined }) !== canonicalJson({ ...result, usage: undefined })) throw new RuntimeError('result_conflict', 'Known result cannot change during usage reconciliation');
    }
    const usage = operation.kind === 'agent' ? result.usage : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (!usage) {
      this.recordConversationOutput(operation, result);
      this.store.db.prepare("UPDATE operations SET state='unknown',worker_active=0,result=? WHERE id=?").run(canonicalJson(result), operation.id);
      this.store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?").run(operation.taskId, operation.nodeId);
      this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND kind='recovery' AND status='open'").run(canonicalJson({ result }), operation.id);
      if (!this.store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'").get(operation.id)) {
        this.store.db.prepare('INSERT INTO questions(id,task_id,node_id,operation_id,kind,data) VALUES(?,?,?,?,?,?)')
          .run(randomUUID(), operation.taskId, operation.nodeId, operation.id, 'unknown_usage', canonicalJson({ reason: 'Agent returned no authoritative usage' }));
        this.store.event(operation.taskId, 'operation.unknown', { operationId: operation.id, reason: 'unknown_usage' });
      }
      return;
    }
    const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
    const total = values.reduce((a, b) => a + b, 0);
    if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(total)) throw new RuntimeError('invalid_usage', 'Invalid disjoint token counts');
    const proposalRow = this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(operation.taskId, operation.proposalVersion) as { spec: string } | undefined;
    const proposal = proposalRow ? JSON.parse(proposalRow.spec) as Proposal : { requirementVersion: 1, summary: '', acceptance: [] as Proposal['acceptance'], nodes: [] as Proposal['nodes'] };
    const nodeSpec = JSON.parse((this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
    if (new Set(result.artifacts?.map(artifact => artifact.id)).size !== (result.artifacts?.length ?? 0) || result.artifacts?.some(artifact => !artifact.id.trim() || !isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.digest))) throw new RuntimeError('invalid_evidence', 'Artifacts require unique IDs, absolute paths and SHA-256 digests');
    if (result.outcome === 'skipped' && !nodeSpec.optional) throw new RuntimeError('invalid_result', 'Only a predeclared optional node may skip work');
    if ((nodeSpec.routes && result.outcome === 'completed' && !nodeSpec.routes.includes(result.route!)) || (result.route !== undefined && !nodeSpec.routes?.includes(result.route))) throw new RuntimeError('invalid_result', 'Router must return a declared case');
    const rework = result.outcome === 'completed' && isReworkDecision(result.output);
    if (result.outcome === 'completed' && !rework && proposal.acceptance.some(item => item.checkNode === operation.nodeId && !result.evidence?.some(evidence => evidence.acceptanceId === item.id))) throw new RuntimeError('invalid_evidence', 'Completed check is missing required acceptance evidence');
    if (rework && result.evidence?.length) throw new RuntimeError('invalid_evidence', 'Rework cannot carry acceptance evidence');
    if (result.evidence?.length && result.outcome !== 'completed') throw new RuntimeError('invalid_evidence', 'Only a completed check may produce acceptance evidence');
    for (const evidence of result.evidence ?? []) {
      if (operation.kind !== 'program' || !proposal.acceptance.some(item => item.id === evidence.acceptanceId && item.checkNode === operation.nodeId)) throw new RuntimeError('invalid_evidence', 'Evidence must come from the assigned program check');
      if (!evidence.summary.trim() || !isAbsolute(evidence.artifact.path) || !/^[a-f0-9]{64}$/.test(evidence.artifact.digest)) throw new RuntimeError('invalid_evidence', 'Evidence requires a summary, absolute artifact path and SHA-256 digest');
      this.store.db.prepare('INSERT INTO evidence(id,task_id,node_id,operation_id,acceptance_id,proposal_version,requirement_version,data,activation_id,commit_sha) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), operation.taskId, operation.nodeId, operation.id, evidence.acceptanceId, operation.proposalVersion, operation.requirementVersion, canonicalJson(evidence), operation.activationId, this.store.task(operation.taskId).integration_sha);
    }
    this.store.db.prepare("UPDATE operations SET state='succeeded',reserved=0,worker_active=0,result=?,usage=? WHERE id=?")
      .run(canonicalJson(result), canonicalJson(usage), operation.id);
    if (operation.instanceId) {
      this.store.db.prepare('UPDATE instances SET used=used+? WHERE id=?').run(total, operation.instanceId);
      const account = this.store.db.prepare('SELECT model,models_used FROM instances WHERE id=?').get(operation.instanceId) as { model: string | null; models_used: string };
      const used = JSON.parse(account.models_used) as string[];
      if (account.model && !used.includes(account.model)) this.store.db.prepare('UPDATE instances SET models_used=? WHERE id=?').run(canonicalJson([...used, account.model]), operation.instanceId);
    }
    this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'").run(canonicalJson({ result }), operation.id);
    if (result.outcome === 'waiting') {
      if (!result.question?.prompt.trim()) throw new RuntimeError('invalid_result', 'Waiting requires a question');
      const node = this.store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as NodeRow;
      // A remote capability that needs an operation grant blocks as a permission
      // question, so answering it persists the exact grant for the next attempt.
      if (result.question.grant) this.block(node, 'permission', { grant: result.question.grant }, operation.id);
      else this.block(node, 'waiting', { prompt: result.question.prompt }, operation.id);
    }
    const conversation = nodeSpec.role === 'master' && operation.kind === 'agent' ? conversationForTask(this.store, operation.taskId) : undefined;
    this.recordConversationOutput(operation, result);
    // A message that arrived while the master was answering must be answered by
    // the next turn instead of being stranded behind a succeeded node.
    const queuedAfter = conversation ? pendingMessages(this.store, conversation.id, 1).length : 0;
    const nextStatus = conversation && result.outcome === 'completed' && queuedAfter ? 'pending' : result.outcome === 'completed' ? 'succeeded' : result.outcome === 'continue' ? 'pending' : result.outcome;
    this.store.db.prepare('UPDATE nodes SET status=?,output=?,route=?,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?')
      .run(nextStatus, canonicalJson(result.output), result.route ?? null, operation.id, operation.taskId, operation.nodeId);
    if (result.outcome === 'failed' && !nodeSpec.optional) {
      const node = this.store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as NodeRow;
      this.block(node, 'execution_failed', { output: result.output }, operation.id);
    }
    if (total > row.reserved) {
      const node = this.store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as NodeRow;
      this.block(node, 'reservation_exceeded', { reserved: row.reserved, actual: total }, operation.id);
    }
    this.store.event(operation.taskId, 'operation.result', { operationId: operation.id, result });
    this.store.db.prepare('UPDATE activations SET state=(SELECT status FROM nodes WHERE task_id=? AND id=?) WHERE id=?').run(operation.taskId, operation.nodeId, operation.activationId);
    if (rework) this.handleRework(operation, result);
    else if (result.outcome === 'completed' && proposal.acceptance.some(item => item.checkNode === operation.nodeId)) {
      for (const loop of loadGraph(this.store, operation.taskId).plan.loops.filter(item => item.from === operation.nodeId)) {
        this.store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(operation.taskId, loop.to);
      }
    }
    this.advance(operation.taskId);
  }

  private handleRework(operation: Operation, result: OperationResult) {
    const graph = loadGraph(this.store, operation.taskId);
    const loops = graph.plan.loops.filter(loop => loop.from === operation.nodeId);
    const decision = result.output as unknown as VerificationDecision;
    const targets = loops.length ? loops.map(loop => loop.to) : decision.subjects.map(subject => subject.nodeId);
    let halt = false;
    for (const target of new Set(targets.length ? targets : [operation.nodeId])) {
      const previous = this.store.db.prepare("SELECT result FROM operations WHERE task_id=? AND node_id=? AND state='succeeded' AND id!=? ORDER BY rowid DESC LIMIT 1")
        .get(operation.taskId, operation.nodeId, operation.id) as { result: string } | undefined;
      const previousOutput = previous ? JSON.parse(previous.result) as OperationResult : undefined;
      const previousIds = new Set(isReworkDecision(previousOutput?.output ?? null) ? (previousOutput!.output as unknown as VerificationDecision).blockers.map(item => item.id) : []);
      const currentIds = new Set(decision.blockers.map(item => item.id));
      const progress = !currentIds.has('invalid_evidence') && [...previousIds].some(id => !currentIds.has(id));
      if (progress) this.store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(operation.taskId, target);
      else this.store.db.prepare('UPDATE nodes SET stall_count=stall_count+1 WHERE task_id=? AND id=?').run(operation.taskId, target);
      const { stall_count } = this.store.db.prepare('SELECT stall_count FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, target) as { stall_count: number };
      if (stall_count >= 3) halt = true;
    }
    const node = this.store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as NodeRow;
    if (halt) {
      const attempts = this.store.db.prepare('SELECT node_id,round,state FROM activations WHERE task_id=? AND node_id IN (' + targets.map(() => '?').join(',') + ') ORDER BY round,rowid')
        .all(operation.taskId, ...(targets.length ? targets : [operation.nodeId])) as { node_id: string; round: number; state: string }[];
      this.block(node, 'stalled', { reason: 'Three consecutive rounds made no substantial progress', resume: targets, blockers: decision.blockers, attempts, evidence: decision.blockers.flatMap(item => item.evidence) }, operation.id);
      return;
    }
    if (!loops.length) {
      this.block(node, 'rework', { output: result.output, resume: targets }, operation.id);
      return;
    }
    reactivate(this.store, operation.taskId, loops.map(loop => loop.to));
    this.store.event(operation.taskId, 'graph.rework', { from: operation.nodeId, to: loops.map(loop => loop.to) });
  }

  private commandNode(spec: NodeSpec): ActionAdapter {
    return {
      kind: 'program',
      prepare: async operation => {
        const input = spec.input as { command?: unknown; args?: unknown } | null;
        if (!input || typeof input.command !== 'string' || !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string')) {
          throw new RuntimeError('invalid_adapter', 'graph.command requires input {command, args}');
        }
        validateWorkspaceCommand(input.command, input.args);
        const projectRoot = (this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(this.store.task(operation.taskId).project_id) as { root: string } | undefined)?.root;
        // Non-git projects have no work copy; their agent instances work in the
        // project root, so the confirmed check runs there too. Git projects
        // must use a work copy so the primary checkout stays untouched.
        const workspace = operation.workspace ?? (projectRoot && !this.git?.repoRoot(operation.taskId) ? projectRoot : undefined);
        if (!workspace) throw new RuntimeError('invalid_adapter', 'graph.command requires a work copy');
        return async () => {
          // The host may provide the project's dependency directory so a
          // confirmed browser check can resolve Playwright from the work copy.
          if (this.program?.nodeModulesPath) {
            const link = join(workspace, 'node_modules');
            if (!existsSync(link)) {
              try { await symlink(await realpath(this.program.nodeModulesPath), link, 'dir'); }
              catch { /* Without the link the check fails with its own resolution error. */ }
            }
          }
          const gate: RestrictedGate = {
            dispatch: (_id, _reservation, send) => {
              if (this.stopping || this.store.task(operation.taskId).paused) throw new RuntimeError('paused', 'Task paused');
              return send();
            },
            settle: () => {},
          };
          const extraReads = this.program?.readPaths
            ? (await Promise.all(this.program.readPaths.map(path => realpath(path).catch(() => undefined)))).filter((path): path is string => path !== undefined)
            : [];
          const runner = await openWorkspaceCommandRunner({
            workspace, scratchDir: join(this.scratchRoot ?? workspace, 'checks', operation.id), gate,
            localNetwork: true,
            ...(extraReads.length ? { readPaths: extraReads } : {}),
            ...(this.program?.env ? { env: this.program.env } : {}),
          });
          try {
            const result = await runner.run(input.command as string, input.args as string[]);
            const proposal = JSON.parse((this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(operation.taskId, operation.proposalVersion) as { spec: string }).spec) as Proposal;
            const acceptanceIds = proposal.acceptance.filter(item => item.checkNode === operation.nodeId).map(item => item.id);
            const body = `${JSON.stringify({ command: input.command, args: input.args, code: result.code, stdout: result.stdout, stderr: result.stderr }, null, 2)}\n`;
            const dir = join(this.scratchRoot ?? workspace, 'checks');
            mkdirSync(dir, { recursive: true });
            const path = join(dir, `${operation.nodeId}.json`);
            writeFileSync(path, body);
            const digest = createHash('sha256').update(body).digest('hex');
            if (result.code !== 0) return { outcome: 'failed', output: { code: result.code, stderr: result.stderr.slice(-4_000) } };
            return {
              outcome: 'completed', output: { code: result.code },
              evidence: acceptanceIds.map(id => ({ acceptanceId: id, summary: `Command exited 0: ${input.command}`, artifact: { path, digest } })),
            };
          } finally { await runner.close(); }
        };
      },
    };
  }

  private humanCheck(): ActionAdapter {
    return {
      kind: 'program',
      prepare: async operation => async () => {
        const proposal = JSON.parse((this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(operation.taskId, operation.proposalVersion) as { spec: string }).spec) as Proposal;
        const root = operation.workspace ?? (this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(this.store.task(operation.taskId).project_id) as { root: string }).root;
        const dir = join(root, '.graph');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${operation.nodeId}.txt`);
        writeFileSync(path, 'acknowledged');
        const digest = createHash('sha256').update('acknowledged').digest('hex');
        return {
          outcome: 'completed' as const, output: { acknowledged: true },
          evidence: proposal.acceptance.filter(item => item.checkNode === operation.nodeId).map(item => ({ acceptanceId: item.id, summary: 'Human check acknowledged', artifact: { path, digest } })),
        };
      },
    };
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
    if (task.integration_branch && !this.independentReviewReady(taskId)) {
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
