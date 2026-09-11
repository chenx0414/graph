import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { canonicalJson, type TaskStore } from './store.ts';
import { loadGraph, reactivate } from './graph.ts';
import { evaluateVerifier, isReworkDecision, type VerificationDecision } from './verification.ts';
import { RuntimeError, type ActionAdapter, type Answer, type Json, type NodeSpec, type Operation, type OperationResult, type Proposal } from './types.ts';

type NodeRow = { id: string; task_id: string; spec: string; instance_id: string | null; status: string; output: string | null; activation_id: string };
export type OperationRow = { id: string; task_id: string; node_id: string; instance_id: string | null; generation: number; spec: string; state: string; reserved: number; worker_active: number; result: string | null; usage: string | null; activation_id: string };

/** Private execution state machine. Every mutation shares the task command/event transaction. */
export class Execution {
  private readonly pending = new Set<Promise<unknown>>();
  private stopping = false;
  private readonly driveWaiters: (() => void)[] = [];
  private readonly store: TaskStore;
  private readonly actions: Record<string, ActionAdapter>;
  private readonly generation: number;
  constructor(store: TaskStore, actions: Record<string, ActionAdapter>) {
    this.store = store; this.actions = actions;
    this.generation = store.transaction(() => {
      store.db.prepare('UPDATE runtime SET generation=generation+1').run();
      const { generation } = store.db.prepare('SELECT generation FROM runtime').get() as { generation: number };
      for (const row of store.db.prepare("SELECT * FROM operations WHERE state IN ('intent','dispatched')").all() as OperationRow[]) {
        if (row.state === 'intent') {
          store.db.prepare("UPDATE operations SET state='not_sent',reserved=0,worker_active=0 WHERE id=?").run(row.id);
          store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(row.task_id, row.node_id);
          store.event(row.task_id, 'operation.not_sent', { operationId: row.id, reason: 'Recovered before dispatch' });
        } else {
          store.db.prepare("UPDATE operations SET state='unknown' WHERE id=?").run(row.id);
          const node = store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(row.task_id, row.node_id) as NodeRow;
          this.block(node, 'recovery', { reason: 'Dispatch was recorded; external outcome and worker liveness require reconciliation' }, row.id);
        }
      }
      return generation;
    });
  }

  async drain() { this.stopping = true; await Promise.allSettled([...this.pending]); }

  report(id: string, generation: number, result: OperationResult) {
    this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationRow | undefined;
      if (!row) throw new RuntimeError('not_found', 'Operation not found');
      if (row.generation !== generation || generation !== this.generation) throw new RuntimeError('stale_generation', 'Worker generation is stale');
      this.settle(JSON.parse(row.spec) as Operation, result);
    });
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
    })();
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
  }

  /** Called only inside the authenticated user command transaction. */
  answer(taskId: string, questionId: string, answer: Answer) {
    const question = this.store.db.prepare('SELECT * FROM questions WHERE id=? AND task_id=?').get(questionId, taskId) as { node_id: string; operation_id: string | null; kind: string; status: string; data: string } | undefined;
    if (!question || question.status !== 'open') throw new RuntimeError('invalid_question', 'No open question in this task');
    if (question.kind === 'budget' && answer.type === 'add_budget') {
      if (!Number.isSafeInteger(answer.tokens) || answer.tokens <= 0) throw new RuntimeError('invalid_answer', 'A positive token increment is required');
      const instance = this.store.db.prepare('SELECT id,budget FROM instances WHERE task_id=? AND node_id=?').get(taskId, question.node_id) as { id: string; budget: number };
      if (!Number.isSafeInteger(instance.budget + answer.tokens)) throw new RuntimeError('invalid_answer', 'Budget exceeds the supported range');
      this.store.db.prepare('UPDATE instances SET budget=budget+? WHERE id=?').run(answer.tokens, instance.id);
    } else if (question.kind === 'unknown_usage' && answer.type === 'usage') {
      const operation = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(question.operation_id!) as OperationRow;
      if (!answer.proof.trim() || !operation.result || operation.worker_active) throw new RuntimeError('invalid_answer', 'Usage requires a known result, quiescent worker and evidence');
      this.settle(JSON.parse(operation.spec) as Operation, { ...JSON.parse(operation.result) as OperationResult, usage: answer.usage });
    } else if (question.kind === 'permission' && answer.type === 'grant') {
      if (answer.grant !== (JSON.parse(question.data) as { grant: string }).grant) throw new RuntimeError('invalid_answer', 'Grant must match the requested capability');
      this.store.db.prepare('INSERT OR IGNORE INTO task_grants VALUES(?,?)').run(taskId, answer.grant);
    } else if (!(question.kind === 'waiting' && answer.type === 'respond') && !(['adapter_error', 'execution_failed'].includes(question.kind) && answer.type === 'retry') && !(question.kind === 'reservation_exceeded' && answer.type === 'acknowledge') && !(['rework', 'stalled'].includes(question.kind) && (answer.type === 'retry' || answer.type === 'respond'))) {
      throw new RuntimeError('invalid_answer', 'Answer type does not match the open question');
    }
    this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?").run(canonicalJson(answer), questionId);
    if (!this.store.db.prepare("SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'").get(taskId, question.node_id)) {
      const last = this.store.db.prepare("SELECT result FROM operations WHERE task_id=? AND node_id=? AND state='succeeded' ORDER BY rowid DESC LIMIT 1").get(taskId, question.node_id) as { result: string } | undefined;
      const completed = last && (JSON.parse(last.result) as OperationResult).outcome === 'completed';
      if (!['rework', 'stalled'].includes(question.kind)) this.store.db.prepare('UPDATE nodes SET status=? WHERE task_id=? AND id=?').run(completed ? 'succeeded' : 'pending', taskId, question.node_id);
    }
    if (['rework', 'stalled'].includes(question.kind) && (answer.type === 'retry' || answer.type === 'respond')) {
      const resume = (JSON.parse(question.data) as { resume?: string[] }).resume ?? [];
      for (const id of [question.node_id, ...resume]) this.store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(taskId, id);
      if (resume.length) reactivate(this.store, taskId, resume);
    }
    this.advance(taskId);
  }

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
    const { active_task } = this.store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    if (!active_task || this.stopping || this.store.task(active_task).paused) return { dispatched: 0 };
    let dispatched = 0;
    const running = new Set<Promise<boolean>>();
    while (!this.stopping && !this.store.task(active_task).paused) {
      const started: Promise<boolean>[] = [];
      for (const node of this.readyNodes()) {
        const spec = JSON.parse(node.spec) as NodeSpec;
        if (this.remainingSlots(spec.kind) <= 0) continue;
        const work = this.run(node);
        started.push(work);
        running.add(work);
        work.finally(() => running.delete(work));
      }
      dispatched += started.length;
      if (running.size === 0) break;
      await Promise.race([...running, new Promise<void>(resolve => this.driveWaiters.push(resolve))]);
    }
    return { dispatched };
  }

  private remainingSlots(kind: NodeSpec['kind']) {
    const { occupied } = this.store.db.prepare(`SELECT COUNT(*) AS occupied FROM operations
      WHERE (state='intent' OR worker_active=1) AND (instance_id IS NOT NULL)=?`).get(Number(kind === 'agent')) as { occupied: number };
    return (kind === 'agent' ? 10 : 4) - occupied;
  }

  private wakeDrive() {
    const waiters = this.driveWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private readyNodes(): NodeRow[] {
    const { active_task } = this.store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    if (!active_task || this.stopping || this.store.task(active_task).paused) return [];
    let nodes: NodeRow[];
    let graph: ReturnType<typeof loadGraph>;
    while (true) {
      nodes = this.store.db.prepare("SELECT * FROM nodes WHERE task_id=? AND status='pending' ORDER BY rowid").all(active_task) as NodeRow[];
      graph = loadGraph(this.store, active_task);
      const skipped = nodes.filter(node => graph.readiness(node.id) === 'skip');
      if (!skipped.length) break;
      this.store.transaction(() => {
        for (const node of skipped) {
          this.store.db.prepare("UPDATE nodes SET status='skipped',output=NULL WHERE task_id=? AND id=?").run(active_task, node.id);
          this.store.db.prepare("UPDATE activations SET state='skipped' WHERE id=?").run(node.activation_id);
          this.store.event(active_task, 'node.skipped', { nodeId: node.id, reason: 'inactive_route' });
        }
      });
    }
    return nodes.filter(node => graph.readiness(node.id) === 'ready');
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
    const adapter = spec.action === 'graph.verify' ? this.graphVerify(spec) : Object.hasOwn(this.actions, spec.action) ? this.actions[spec.action] : undefined;
    if (!adapter || adapter.kind !== spec.kind) {
      this.store.transaction(() => this.block(node, 'adapter_error', { reason: `No ${spec.kind} adapter for ${spec.action}` }));
      return false;
    }
    const baseGrants = JSON.parse((this.store.db.prepare('SELECT grants FROM projects WHERE id=?').get(this.store.task(node.task_id).project_id) as { grants: string }).grants) as string[];
    const grants = [...new Set([...baseGrants, ...(this.store.db.prepare('SELECT grant FROM task_grants WHERE task_id=?').all(node.task_id) as { grant: string }[]).map(row => row.grant)])];
    const requiredGrant = adapter.grant;
    if (requiredGrant && !grants.includes(requiredGrant)) {
      this.store.transaction(() => this.block(node, 'permission', { grant: requiredGrant }));
      return false;
    }
    const { occupied } = this.store.db.prepare(`SELECT COUNT(*) AS occupied FROM operations
      WHERE (state='intent' OR worker_active=1) AND (instance_id IS NOT NULL)=?`).get(Number(spec.kind === 'agent')) as { occupied: number };
    if (occupied >= (spec.kind === 'agent' ? 10 : 4)) return false;
    const reservation = spec.kind === 'agent' ? adapter.reserveTokens : 0;
    if (reservation === undefined || !Number.isSafeInteger(reservation) || reservation < 0) throw new RuntimeError('invalid_adapter', 'A bounded token reservation is required');
    if (node.instance_id) {
      const account = this.store.db.prepare('SELECT budget,used FROM instances WHERE id=?').get(node.instance_id) as { budget: number; used: number };
      const { reserved } = this.store.db.prepare('SELECT COALESCE(SUM(reserved),0) AS reserved FROM operations WHERE instance_id=?').get(node.instance_id) as { reserved: number };
      if (account.used >= account.budget || account.used + reserved + reservation > account.budget) {
        this.store.transaction(() => this.block(node, 'budget', { budget: account.budget, used: account.used, reserved, requested: reservation }));
        return false;
      }
    }
    const operation = this.store.transaction(() => {
      const task = this.store.task(node.task_id);
      const attempt = (this.store.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE task_id=? AND node_id=?').get(node.task_id, node.id) as { count: number }).count + 1;
      const graph = loadGraph(this.store, node.task_id);
      const dependencies = graph.inputs(node.id);
      const dependencySources = graph.sources(node.id);
      const inputVersions = Object.fromEntries(Object.entries(dependencySources).map(([id, sources]) => [id, sources.map(source => ({ activationId: source.activationId, outputVersion: source.outputVersion }))]));
      const answers = (this.store.db.prepare("SELECT id,answer FROM questions WHERE task_id=? AND node_id=? AND kind='waiting' AND status='resolved' ORDER BY rowid").all(node.task_id, node.id) as { id: string; answer: string }[])
        .map(row => ({ questionId: row.id, value: (JSON.parse(row.answer) as { value: Json }).value }));
      const operation: Operation = { id: randomUUID(), taskId: node.task_id, nodeId: node.id, instanceId: node.instance_id,
        generation: this.generation, attempt, kind: spec.kind, action: spec.action, input: spec.input ?? null, dependencies,
        proposalVersion: task.accepted_proposal!, requirementVersion: task.requirement_version,
        context: { previousOutput: node.output ? JSON.parse(node.output) as Json : null, answers }, grants,
        activationId: node.activation_id, graphVersion: task.graph_version, dependencySources, inputVersions };
      this.store.db.prepare("INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id) VALUES(?,?,?,?,?,?,'intent',?,?)")
        .run(operation.id, node.task_id, node.id, node.instance_id, operation.generation, canonicalJson(operation), reservation, node.activation_id);
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
        this.block(node, 'adapter_error', { reason: String(error) }, operation.id);
      });
      return false;
    }
    if (this.stopping || this.store.task(node.task_id).paused) {
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE operations SET state='not_sent',reserved=0 WHERE id=?").run(operation.id);
        this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(node.task_id, node.id);
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
      const result = await dispatch();
      quiescent = true;
      this.report(operation.id, operation.generation, result);
    } catch (error) {
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
    const proposal = JSON.parse((this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(operation.taskId, operation.proposalVersion) as { spec: string }).spec) as Proposal;
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
      this.store.db.prepare('INSERT INTO evidence(id,task_id,node_id,operation_id,acceptance_id,proposal_version,requirement_version,data,activation_id) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), operation.taskId, operation.nodeId, operation.id, evidence.acceptanceId, operation.proposalVersion, operation.requirementVersion, canonicalJson(evidence), operation.activationId);
    }
    this.store.db.prepare("UPDATE operations SET state='succeeded',reserved=0,worker_active=0,result=?,usage=? WHERE id=?")
      .run(canonicalJson(result), canonicalJson(usage), operation.id);
    if (operation.instanceId) this.store.db.prepare('UPDATE instances SET used=used+? WHERE id=?').run(total, operation.instanceId);
    this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'").run(canonicalJson({ result }), operation.id);
    if (result.outcome === 'waiting') {
      if (!result.question?.prompt.trim()) throw new RuntimeError('invalid_result', 'Waiting requires a question');
      const node = this.store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as NodeRow;
      this.block(node, 'waiting', { prompt: result.question.prompt }, operation.id);
    }
    this.store.db.prepare('UPDATE nodes SET status=?,output=?,route=?,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?')
      .run(result.outcome === 'completed' ? 'succeeded' : result.outcome === 'continue' ? 'pending' : result.outcome, canonicalJson(result.output), result.route ?? null, operation.id, operation.taskId, operation.nodeId);
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

  private advance(taskId: string) {
    const task = this.store.task(taskId);
    if (task.phase !== 'running') return;
    const graph = loadGraph(this.store, taskId);
    const incomplete = [...graph.plan.nodes.keys()].some(id => !['succeeded', 'skipped'].includes(graph.status(id)));
    const blocked = this.store.db.prepare("SELECT id FROM questions WHERE task_id=? AND status='open'").get(taskId);
    if (incomplete || blocked) return;
    const proposal = JSON.parse((this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(taskId, task.accepted_proposal!) as { spec: string }).spec) as Proposal;
    const evidence = this.store.db.prepare('SELECT acceptance_id FROM evidence WHERE task_id=? AND proposal_version=? AND requirement_version=? AND valid=1').all(taskId, task.accepted_proposal!, task.requirement_version) as { acceptance_id: string }[];
    if (proposal.acceptance.every(item => evidence.some(row => row.acceptance_id === item.id))) {
      this.store.db.prepare("UPDATE tasks SET phase='completed' WHERE id=?").run(taskId);
      const next = this.store.db.prepare("SELECT id FROM tasks WHERE phase='queued' ORDER BY created_seq LIMIT 1").get() as { id: string } | undefined;
      this.store.db.prepare('UPDATE runtime SET active_task=?').run(next?.id ?? null);
      this.store.event(taskId, 'task.completed', { proposalVersion: task.accepted_proposal });
      if (next) {
        this.store.db.prepare("UPDATE tasks SET phase='running' WHERE id=?").run(next.id);
        this.store.event(next.id, 'task.started', {});
      }
    }
  }
}
