import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { estimateCost, type ModelEntry } from '../catalog/models.ts';
import {
  addBudget,
  commitUsage,
  recordCurrentModelUse,
  releaseOperationReservation,
  reserveOperation,
  unknownUsageIsNonBlocking,
} from './budget-ledger.ts';
import {
  clearConversationStream,
  conversationForTask,
  pendingMessages,
  recordConversationInterruption,
  recordConversationOutput,
  releaseMessages,
} from './conversation.ts';
import { loadGraph, reactivate } from './graph.ts';
import { resultHandoffDependents, resultHandoffFailure, settleResultHandoff } from './predecessor-handoff.ts';
import { canonicalJson, type TaskStore } from './store.ts';
import { closeUserWait, closeUserWaitForOperation } from './time-ledger.ts';
import { isReworkDecision, type VerificationDecision } from './verification.ts';
import { insertQuestion } from './question-routing.ts';
import {
  mergeUsageSource,
  normalizeTokenUsage,
  tokenUsageTotal,
  usageSourceOf,
  type UsageSource,
} from '../runtime/call-broker.ts';
import {
  RuntimeError,
  type Answer,
  type Json,
  type NodeSpec,
  type Operation,
  type OperationResult,
  type Proposal,
  type Reconciliation,
  type TokenUsage,
} from './types.ts';

interface OperationDbRow {
  id: string;
  task_id: string;
  node_id: string;
  instance_id: string | null;
  generation: number;
  spec: string;
  state: string;
  reserved: number;
  worker_active: number;
  result: string | null;
  usage: string | null;
  activation_id: string | null;
  waiting_slot: number;
  dispatched_at: number | null;
  settled_at: number | null;
  waiting_ms: number;
}

interface NodeDbRow {
  id: string;
  task_id: string;
  spec: string;
  instance_id: string | null;
  status: string;
  output: string | null;
  activation_id: string;
}

export interface OperationNode {
  id: string;
  taskId: string;
  activationId: string;
}

export type OperationIntent = Omit<Operation, 'id' | 'generation' | 'attempt'>;

export interface OperationSnapshot {
  id: string;
  operation: Operation;
  state: string;
  reserved: number;
  workerActive: boolean;
  result: OperationResult | null;
}

export interface OperationRun {
  id: string;
  state: string;
  activationId: string | null;
  workerActive: boolean;
  waitingSlot: boolean;
  reserved: number;
  waitingMs: number;
  runMs: number | null;
  dispatchedAt: number | null;
  settledAt: number | null;
  result: Json;
  usage: Json;
}

export interface OperationLifecycleHooks {
  advance(taskId: string): void;
}

function operationFrom(row: OperationDbRow) {
  return JSON.parse(row.spec) as Operation;
}

function tokenTotal(usage: TokenUsage) {
  return tokenUsageTotal(usage);
}

function sumKnownUsage(rows: { usage: string | null }[]) {
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let source: UsageSource | undefined;
  for (const row of rows) {
    if (!row.usage) continue;
    const usage = JSON.parse(row.usage) as TokenUsage;
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    const next = usageSourceOf(usage);
    source = source ? mergeUsageSource(source, next) : next;
  }
  return { ...total, usageSource: source ?? 'unknown' } satisfies TokenUsage;
}

/**
 * Transaction-scoped owner of the formal operation state machine.
 *
 * Adapters provide the actual model, Git, program or Pi work. This module owns
 * the durable ordering around that work: intent, dispatch, reconciliation,
 * settlement, blocking questions and rework.
 */
export class OperationLifecycle {
  private generation = 0;
  private readonly store: TaskStore;
  private readonly hooks: OperationLifecycleHooks;

  constructor(store: TaskStore, hooks: OperationLifecycleHooks) {
    this.store = store;
    this.hooks = hooks;
  }

  private transaction<T>(action: () => T): T {
    return this.store.db.isTransaction ? action() : this.store.transaction(action);
  }

  private operationRow(id: string) {
    const row = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationDbRow | undefined;
    if (!row) throw new RuntimeError('not_found', 'Operation not found');
    return row;
  }

  get(id: string): OperationSnapshot | undefined {
    const row = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationDbRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      operation: operationFrom(row),
      state: row.state,
      reserved: row.reserved,
      workerActive: Boolean(row.worker_active),
      result: row.result ? JSON.parse(row.result) as OperationResult : null,
    };
  }

  private nodeRow(taskId: string, nodeId: string) {
    const row = this.store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as NodeDbRow | undefined;
    if (!row) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
    return row;
  }

  /** Enter a new runtime generation and conservatively recover prior work. */
  recover() {
    return this.transaction(() => {
      this.store.db.prepare('UPDATE runtime SET generation=generation+1').run();
      const { generation } = this.store.db.prepare('SELECT generation FROM runtime').get() as { generation: number };
      this.generation = generation;
      const rows = this.store.db.prepare("SELECT * FROM operations WHERE state IN ('intent','dispatched')").all() as unknown as OperationDbRow[];
      for (const row of rows) {
        if (row.state === 'intent') {
          this.markNotSent(row, {
            resetNode: true,
            eventReason: 'Recovered before dispatch',
          });
        } else {
          // A new process owns no live worker, so a recorded dispatch is
          // uncertain and must stop holding an execution slot. Leaving
          // worker_active=1 would starve every later agent and block usage
          // reconciliation.
          this.store.db.prepare("UPDATE operations SET state='unknown',worker_active=0,waiting_slot=0 WHERE id=?").run(row.id);
          this.store.event(row.task_id, 'operation.unknown', {
            operationId: row.id,
            reason: 'Recovered after restart with no live worker',
            quiescent: true,
          });
          this.block(row.task_id, row.node_id, 'recovery', {
            reason: 'Dispatch was recorded; external outcome and worker liveness require reconciliation',
          }, row.id);
        }
      }
      // Rows already marked unknown by an earlier process can keep a stale
      // worker flag as well (for example after a crash during reconciliation).
      this.store.db.prepare("UPDATE operations SET worker_active=0 WHERE state='unknown' AND worker_active=1").run();
      return generation;
    });
  }

  /**
   * Create the durable intent before any adapter can cause an external effect.
   * `afterIntent` runs in the same transaction after the row exists, so context
   * freezing and conversation delivery are atomic with the intent.
   */
  admit(input: {
    node: OperationNode;
    reservation: number;
    prepare(attempt: number): OperationIntent;
    afterIntent?(operation: Operation): void;
  }) {
    return this.transaction(() => {
      if (!Number.isSafeInteger(input.reservation) || input.reservation < 0) {
        throw new RuntimeError('invalid_adapter', 'A bounded token reservation is required');
      }
      const { count } = this.store.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE task_id=? AND node_id=?')
        .get(input.node.taskId, input.node.id) as { count: number };
      const attempt = count + 1;
      const operation: Operation = {
        ...input.prepare(attempt),
        id: randomUUID(),
        generation: this.generation,
        attempt,
      };
      this.store.db.prepare(`INSERT INTO operations(
        id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id
      ) VALUES(?,?,?,?,?,?,'intent',?,?)`).run(
        operation.id,
        operation.taskId,
        operation.nodeId,
        operation.instanceId,
        operation.generation,
        canonicalJson(operation),
        0,
        operation.activationId,
      );
      reserveOperation(this.store, operation.id, input.reservation);
      input.afterIntent?.(operation);
      this.store.db.prepare("UPDATE activations SET input_versions=?,state='preparing' WHERE id=?")
        .run(canonicalJson(operation.inputVersions), operation.activationId);
      this.store.db.prepare("UPDATE nodes SET status='preparing' WHERE task_id=? AND id=?")
        .run(operation.taskId, operation.nodeId);
      this.store.event(operation.taskId, 'operation.intent', operation);
      return operation;
    });
  }

  private markNotSent(row: OperationDbRow, options: { resetNode: boolean; eventReason?: string }) {
    const now = Date.now();
    clearConversationStream(this.store, row.id);
    this.store.db.prepare(`UPDATE operations
      SET state='not_sent',worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?)
      WHERE id=?`).run(now, row.id);
    releaseOperationReservation(this.store, row.id);
    if (options.resetNode) {
      this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(row.task_id, row.node_id);
    }
    if (options.eventReason !== undefined) {
      this.store.event(row.task_id, 'operation.not_sent', { operationId: row.id, reason: options.eventReason });
    }
  }

  /** Roll back a pre-dispatch attempt while preserving the same node identity. */
  cancelBeforeDispatch(operationId: string, reason = 'Cancelled before dispatch') {
    this.transaction(() => {
      const row = this.operationRow(operationId);
      this.markNotSent(row, {
        resetNode: true,
        eventReason: reason,
      });
      releaseMessages(this.store, operationId);
    });
  }

  markPreparationFailed(operationId: string, reason: string) {
    this.transaction(() => {
      const row = this.operationRow(operationId);
      this.markNotSent(row, { resetNode: false });
      releaseMessages(this.store, operationId);
      this.block(row.task_id, row.node_id, 'adapter_error', { reason }, row.id);
      recordConversationInterruption(this.store, operationFrom(row), reason);
    });
  }

  /** Commit the dispatch boundary immediately before the adapter may send. */
  dispatch(operation: Operation) {
    this.transaction(() => {
      const now = Date.now();
      this.store.db.prepare("UPDATE operations SET state='dispatched',worker_active=1,dispatched_at=COALESCE(dispatched_at,?) WHERE id=?")
        .run(now, operation.id);
      this.store.db.prepare("UPDATE nodes SET status='running' WHERE task_id=? AND id=?")
        .run(operation.taskId, operation.nodeId);
      this.store.db.prepare("UPDATE activations SET state='running' WHERE id=?")
        .run(operation.activationId);
      this.store.event(operation.taskId, 'operation.dispatched', { operationId: operation.id });
    });
  }

  report(id: string, generation: number, result: OperationResult) {
    return this.transaction(() => {
      const row = this.operationRow(id);
      if (row.generation !== generation || generation !== this.generation) {
        throw new RuntimeError('stale_generation', 'Worker generation is stale');
      }
      const operation = operationFrom(row);
      this.settle(operation, result);
      return operation.taskId;
    });
  }

  async steer(operationId: string, steer: (operation: Operation) => Promise<void>) {
    const row = this.operationRow(operationId);
    if (row.state !== 'dispatched' || !row.worker_active) {
      throw new RuntimeError('no_active_operation', 'The master Agent is no longer accepting steering messages');
    }
    await steer(operationFrom(row));
  }

  /** Reconcile an unknown external outcome and apply the verified transition. */
  async reconcile(
    id: string,
    reconcile: (operation: Operation) => Promise<Reconciliation>,
    options: { integrate?: (operation: Operation) => Promise<void> } = {},
  ) {
    const row = this.operationRow(id);
    if (row.state !== 'unknown') return;
    const operation = operationFrom(row);
    const evidence = await reconcile(operation);
    if (!evidence.proof.trim()) throw new RuntimeError('invalid_reconciliation', 'Reconciliation requires evidence');
    if (evidence.state === 'completed'
      && options.integrate
      && operation.kind === 'agent'
      && evidence.result.outcome === 'completed') {
      await options.integrate(operation);
    }
    this.transaction(() => {
      const current = this.store.db.prepare('SELECT state,result FROM operations WHERE id=?').get(id) as
        { state: string; result: string | null };
      if (current.state !== 'unknown') return;
      if (evidence.state === 'completed') {
        if (!evidence.quiescent) throw new RuntimeError('invalid_reconciliation', 'Completion must prove the worker is quiescent');
        this.settle(operation, evidence.result);
      } else if (evidence.state === 'not_started') {
        if (!evidence.quiescent || current.result) {
          throw new RuntimeError('invalid_reconciliation', 'Cannot retry an operation with a known result or a live worker');
        }
        this.markNotSent(this.operationRow(id), { resetNode: true });
        this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'")
          .run(canonicalJson(evidence), id);
        closeUserWaitForOperation(this.store, id);
      } else {
        this.store.db.prepare('UPDATE operations SET worker_active=? WHERE id=?').run(Number(!evidence.quiescent), id);
      }
      this.store.event(operation.taskId, 'operation.reconciled', { operationId: id, evidence });
    });
    return operation.taskId;
  }

  /**
   * Handle a refusal raised at the send boundary. A gate refusal proves the
   * refused call was not sent; partial invocation records make the attempt
   * interrupted instead of silently replayable.
   */
  handleDispatchRefusal(operation: Operation, error: RuntimeError, reservation: number) {
    const refusalCodes = ['paused', 'budget', 'unknown_usage', 'context_rejected'];
    if (!refusalCodes.includes(error.code)) return false;
    return this.transaction(() => {
      const row = this.operationRow(operation.id);
      if (!['dispatched', 'unknown'].includes(row.state)) return false;
      const invocations = this.store.db.prepare('SELECT usage FROM invocations WHERE operation_id=?')
        .all(operation.id) as { usage: string | null }[];
      const known = invocations.map(item => item.usage ? JSON.parse(item.usage) as TokenUsage : null);
      const unknown = known.some(value => {
        if (!value) return true;
        const source = usageSourceOf(value);
        return source === 'unknown' || (source === 'estimated' && !unknownUsageIsNonBlocking(this.store, operation.instanceId));
      });
      const total = known.reduce((sum, value) => sum + (value ? tokenTotal(value) : 0), 0);
      const state = invocations.length ? 'interrupted' : 'not_sent';
      clearConversationStream(this.store, operation.id);
      this.store.db.prepare(`UPDATE operations
        SET state=?,worker_active=0,waiting_slot=0,settled_at=COALESCE(settled_at,?)
        WHERE id=?`).run(state, Date.now(), operation.id);
      releaseOperationReservation(this.store, operation.id);
      if (state === 'interrupted') {
        if (!unknown && total > 0 && operation.instanceId) {
          commitUsage(this.store, operation.instanceId, total);
          recordCurrentModelUse(this.store, operation.instanceId);
        }
        this.store.event(operation.taskId, 'operation.interrupted', {
          operationId: operation.id,
          reason: error.message,
          usage: unknown ? null : total,
          invocations: invocations.length,
        });
      } else {
        releaseMessages(this.store, operation.id);
        this.store.event(operation.taskId, 'operation.not_sent', {
          operationId: operation.id,
          reason: error.message,
        });
      }
      if (error.code === 'budget') {
        this.block(operation.taskId, operation.nodeId, 'budget', { reason: error.message, requested: reservation }, operation.id);
      } else if (error.code === 'context_rejected') {
        const node = this.nodeRow(operation.taskId, operation.nodeId);
        const spec = JSON.parse(node.spec) as NodeSpec;
        const data = {
          reason: error.message,
          code: error.code,
          requiredFacts: (spec.context?.requiredFacts ?? []) as unknown as Json,
          policy: spec.context?.independence ?? 'none',
        };
        this.store.event(operation.taskId, 'context.rejected', { nodeId: operation.nodeId, operationId: operation.id, ...data });
        this.block(operation.taskId, operation.nodeId, 'context_rejected', data, operation.id);
      } else if (unknown || error.code === 'unknown_usage') {
        const existing = this.store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'")
          .get(operation.id) as { id: string } | undefined;
        if (existing) {
          this.store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?")
            .run(operation.taskId, operation.nodeId);
        } else {
          this.block(operation.taskId, operation.nodeId, 'unknown_usage', { reason: error.message });
        }
      } else {
        this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?")
          .run(operation.taskId, operation.nodeId);
      }
      return true;
    });
  }

  /** Record a post-dispatch error whose external outcome cannot be proven. */
  markUncertain(operation: Operation, error: unknown, quiescent: boolean) {
    return this.transaction(() => {
      const current = this.store.db.prepare('SELECT state FROM operations WHERE id=?').get(operation.id) as { state: string };
      if (!['dispatched', 'unknown'].includes(current.state)) {
        this.store.event(operation.taskId, 'operation.report_rejected', {
          operationId: operation.id,
          reason: String(error),
        });
        return false;
      }
      this.store.db.prepare("UPDATE operations SET state='unknown',worker_active=? WHERE id=?")
        .run(Number(!quiescent), operation.id);
      // Terminal for the live transcript: the stream must stop showing an
      // unfinished answer even though the operation is not settled.
      this.store.event(operation.taskId, 'operation.unknown', {
        operationId: operation.id,
        reason: String(error),
        quiescent,
      });
      this.block(operation.taskId, operation.nodeId, 'recovery', { reason: String(error) }, operation.id);
      recordConversationInterruption(this.store, operation, String(error));
      return true;
    });
  }

  block(taskId: string, nodeId: string, kind: string, data: Json, operationId: string | null = null) {
    return this.transaction(() => {
      const node = this.nodeRow(taskId, nodeId);
      this.store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?").run(taskId, nodeId);
      this.store.db.prepare("UPDATE activations SET state='blocked' WHERE id=?").run(node.activation_id);
      let autoAnswer: { answer: Answer; policyDigest: string; resume?: boolean } | undefined;
      if (operationId && kind === 'permission') {
        const operation = this.get(operationId);
        const grant = data && typeof data === 'object' && !Array.isArray(data) && typeof data.grant === 'string'
          ? data.grant
          : undefined;
        if (operation?.operation.accessPolicy?.autoApprove.permission && grant) {
          autoAnswer = {
            answer: { type: 'grant', grant },
            policyDigest: operation.operation.accessPolicy.digest,
            resume: true,
          };
        }
      }
      return insertQuestion(this.store, {
        taskId,
        nodeId,
        operationId,
        kind,
        data,
        ...(autoAnswer ? { autoAnswer } : {}),
      }).id;
    });
  }

  /**
   * Resolve a human answer. The command layer has already authenticated the
   * task and request; this module owns how the answer changes formal state.
   */
  answer(taskId: string, questionId: string, answer: Answer, models?: () => ModelEntry[]) {
    this.transaction(() => {
      const question = this.store.db.prepare('SELECT * FROM questions WHERE id=? AND task_id=?')
        .get(questionId, taskId) as {
          node_id: string;
          operation_id: string | null;
          kind: string;
          status: string;
          data: string;
        } | undefined;
      if (!question || question.status !== 'open') throw new RuntimeError('invalid_question', 'No open question in this task');
      if (question.kind === 'budget' && answer.type === 'add_budget') {
        if (!Number.isSafeInteger(answer.tokens) || answer.tokens <= 0) {
          throw new RuntimeError('invalid_answer', 'A positive token increment is required');
        }
        const instance = this.store.db.prepare('SELECT id FROM instances WHERE task_id=? AND node_id=?')
          .get(taskId, question.node_id) as { id: string };
        addBudget(this.store, instance.id, answer.tokens);
      } else if (question.kind === 'unknown_usage' && (answer.type === 'usage' || answer.type === 'reconcile_usage')) {
        this.answerUnknownUsage(question.operation_id!, answer, models);
      } else if (question.kind === 'permission' && answer.type === 'grant') {
        if (answer.grant !== (JSON.parse(question.data) as { grant: string }).grant) {
          throw new RuntimeError('invalid_answer', 'Grant must match the requested capability');
        }
        this.store.db.prepare('INSERT OR IGNORE INTO task_grants VALUES(?,?)').run(taskId, answer.grant);
      } else if (question.kind === 'system_change' && answer.type === 'respond') {
        const value = answer.value;
        const decision = value && typeof value === 'object' && !Array.isArray(value)
          ? (value as { decision?: unknown }).decision
          : undefined;
        if (decision !== 'approved' && decision !== 'rejected') {
          throw new RuntimeError('invalid_answer', 'A system change must be approved or rejected');
        }
      } else if (!(question.kind === 'waiting' && answer.type === 'respond')
        && !(['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict', 'context_rejected'].includes(question.kind) && answer.type === 'retry')
        && !(['reservation_exceeded', 'human_check', 'git_dirty'].includes(question.kind) && answer.type === 'acknowledge')
        && !(['rework', 'stalled'].includes(question.kind) && (answer.type === 'retry' || answer.type === 'respond'))) {
        throw new RuntimeError('invalid_answer', 'Answer type does not match the open question');
      }
      this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?").run(canonicalJson(answer), questionId);
      closeUserWait(this.store, taskId, question.node_id);
      if (!this.store.db.prepare("SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'").get(taskId, question.node_id)) {
        const current = this.store.db.prepare(`SELECT o.state,o.result
          FROM operations o JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
          WHERE o.task_id=? AND o.node_id=? AND o.activation_id=n.activation_id
          ORDER BY o.rowid DESC LIMIT 1`).get(taskId, question.node_id) as { state: string; result: string | null } | undefined;
        const completed = current?.state === 'succeeded'
          && current.result !== null
          && (JSON.parse(current.result) as OperationResult).outcome === 'completed';
        const spec = JSON.parse((this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?')
          .get(taskId, question.node_id) as { spec: string }).spec) as NodeSpec;
        const conversation = spec.role === 'master' ? conversationForTask(this.store, taskId) : undefined;
        const queued = conversation ? pendingMessages(this.store, conversation.id, 1).length : 0;
        if (!['rework', 'stalled'].includes(question.kind)) {
          this.store.db.prepare('UPDATE nodes SET status=? WHERE task_id=? AND id=?')
            .run(question.kind === 'system_change' || !completed || queued ? 'pending' : 'succeeded', taskId, question.node_id);
        }
      }
      if (['rework', 'stalled'].includes(question.kind) && (answer.type === 'retry' || answer.type === 'respond')) {
        const resume = (JSON.parse(question.data) as { resume?: string[] }).resume ?? [];
        for (const id of [question.node_id, ...resume]) {
          this.store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(taskId, id);
        }
        if (resume.length) reactivate(this.store, taskId, resume);
      }
      this.hooks.advance(taskId);
    });
  }

  private answerUnknownUsage(
    operationId: string,
    answer: { type: 'usage'; usage: TokenUsage; proof: string } | { type: 'reconcile_usage'; proof: string },
    models?: () => ModelEntry[],
  ) {
    const row = this.operationRow(operationId);
    if (row.state === 'interrupted') {
      this.recordInterruptedUsage(row, answer, models);
      return;
    }
    if (!answer.proof.trim() || !row.result || row.worker_active) {
      throw new RuntimeError('invalid_answer', 'Usage requires a known result, quiescent worker and evidence');
    }
    const operation = operationFrom(row);
    const result = JSON.parse(row.result) as OperationResult;
    if (answer.type === 'usage') {
      this.settle(operation, { ...result, usage: normalizeTokenUsage(answer.usage) });
      return;
    }
    const knownRows = (this.store.db.prepare('SELECT usage FROM invocations WHERE operation_id=? AND usage IS NOT NULL')
      .all(operationId) as { usage: string }[]);
    const known = sumKnownUsage(knownRows);
    this.settle(operation, { ...result, usage: known }, { reconciled: true });
    this.store.event(operation.taskId, 'operation.usage_reconciled', {
      operationId,
      decision: 'usage_unavailable',
      known,
      proof: answer.proof,
    });
  }

  private recordInterruptedUsage(
    row: OperationDbRow,
    answer: { type: 'usage'; usage: TokenUsage; proof: string } | { type: 'reconcile_usage'; proof: string },
    models?: () => ModelEntry[],
  ) {
    if (!answer.proof.trim()) throw new RuntimeError('invalid_answer', 'Evidence is required to release unknown usage');
    if (row.result || row.worker_active) {
      throw new RuntimeError('invalid_answer', 'Interrupted usage reconciliation requires a quiescent operation without a result');
    }
    if (answer.type === 'usage') {
      const unknown = this.store.db.prepare('SELECT id FROM invocations WHERE operation_id=? AND usage IS NULL')
        .all(row.id) as { id: string }[];
      if (unknown.length !== 1) {
        throw new RuntimeError('invalid_answer', 'Recording authoritative usage requires exactly one unknown invocation');
      }
      const values = [answer.usage.input, answer.usage.output, answer.usage.cacheRead, answer.usage.cacheWrite];
      const total = values.reduce((sum, value) => sum + value, 0);
      if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(total)) {
        throw new RuntimeError('invalid_usage', 'Invalid disjoint token counts');
      }
      const instance = row.instance_id
        ? this.store.db.prepare('SELECT model FROM instances WHERE id=?').get(row.instance_id) as { model: string | null }
        : undefined;
      const entry = instance?.model ? models?.().find(model => model.id === instance.model) : undefined;
      const usage = normalizeTokenUsage(answer.usage);
      this.store.db.prepare('UPDATE invocations SET usage=?,cost=? WHERE id=?')
        .run(canonicalJson(usage), canonicalJson(estimateCost(usage, entry?.cost, entry?.pricing)), unknown[0]!.id);
    }
    const knownRows = (this.store.db.prepare('SELECT usage FROM invocations WHERE operation_id=? AND usage IS NOT NULL')
      .all(row.id) as { usage: string }[]);
    const known = sumKnownUsage(knownRows);
    const total = tokenTotal(known);
    if (total > 0 && row.instance_id) {
      commitUsage(this.store, row.instance_id, total);
      recordCurrentModelUse(this.store, row.instance_id);
    }
    this.store.event(row.task_id, 'operation.usage_reconciled', {
      operationId: row.id,
      decision: answer.type === 'usage' ? 'recorded' : 'usage_unavailable',
      known,
      proof: answer.proof,
    });
  }

  private handleRework(operation: Operation, result: OperationResult) {
    const graph = loadGraph(this.store, operation.taskId);
    const loops = graph.plan.loops.filter(loop => loop.from === operation.nodeId);
    const decision = result.output as unknown as VerificationDecision;
    const targets = loops.length ? loops.map(loop => loop.to) : decision.subjects.map(subject => subject.nodeId);
    let halt = false;
    for (const target of new Set(targets.length ? targets : [operation.nodeId])) {
      const previous = this.store.db.prepare(`SELECT result FROM operations
        WHERE task_id=? AND node_id=? AND state='succeeded' AND id!=? ORDER BY rowid DESC LIMIT 1`)
        .get(operation.taskId, operation.nodeId, operation.id) as { result: string } | undefined;
      const previousOutput = previous ? JSON.parse(previous.result) as OperationResult : undefined;
      const previousIds = new Set(isReworkDecision(previousOutput?.output ?? null)
        ? (previousOutput!.output as unknown as VerificationDecision).blockers.map(item => item.id)
        : []);
      const currentIds = new Set(decision.blockers.map(item => item.id));
      const progress = !currentIds.has('invalid_evidence') && [...previousIds].some(id => !currentIds.has(id));
      if (progress) {
        this.store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(operation.taskId, target);
      } else {
        this.store.db.prepare('UPDATE nodes SET stall_count=stall_count+1 WHERE task_id=? AND id=?').run(operation.taskId, target);
      }
      const { stall_count } = this.store.db.prepare('SELECT stall_count FROM nodes WHERE task_id=? AND id=?')
        .get(operation.taskId, target) as { stall_count: number };
      if (stall_count >= 3) halt = true;
    }
    if (halt) {
      const attempts = this.store.db.prepare('SELECT node_id,round,state FROM activations WHERE task_id=? AND node_id IN ('
        + targets.map(() => '?').join(',') + ') ORDER BY round,rowid')
        .all(operation.taskId, ...(targets.length ? targets : [operation.nodeId])) as { node_id: string; round: number; state: string }[];
      this.block(operation.taskId, operation.nodeId, 'stalled', {
        reason: 'Three consecutive rounds made no substantial progress',
        resume: targets,
        blockers: decision.blockers,
        attempts,
        evidence: decision.blockers.flatMap(item => item.evidence),
      }, operation.id);
      return;
    }
    if (!loops.length) {
      this.block(operation.taskId, operation.nodeId, 'rework', {
        output: result.output,
        resume: targets,
      }, operation.id);
      return;
    }
    reactivate(this.store, operation.taskId, loops.map(loop => loop.to));
    this.store.event(operation.taskId, 'graph.rework', {
      from: operation.nodeId,
      to: loops.map(loop => loop.to),
    });
  }

  private settle(operation: Operation, result: OperationResult, options: { reconciled?: boolean } = {}) {
    if (!result || !['completed', 'continue', 'waiting', 'failed', 'skipped'].includes(result.outcome)) {
      throw new RuntimeError('invalid_result', 'Unexpected operation outcome');
    }
    canonicalJson(result);
    const row = this.operationRow(operation.id);
    if (row.state === 'succeeded') {
      if (row.result !== canonicalJson(result)) throw new RuntimeError('result_conflict', 'Operation already has a different result');
      return;
    }
    if (!['dispatched', 'unknown'].includes(row.state)) throw new RuntimeError('invalid_operation', 'Operation was not dispatched');
    const currentNode = this.store.db.prepare('SELECT activation_id FROM nodes WHERE task_id=? AND id=?')
      .get(operation.taskId, operation.nodeId) as { activation_id: string };
    if (currentNode.activation_id !== operation.activationId) {
      throw new RuntimeError('stale_activation', 'Operation belongs to a replaced activation');
    }
    clearConversationStream(this.store, operation.id);
    if (row.result) {
      const previous = JSON.parse(row.result) as OperationResult;
      if (canonicalJson({ ...previous, usage: undefined }) !== canonicalJson({ ...result, usage: undefined })) {
        throw new RuntimeError('result_conflict', 'Known result cannot change during usage reconciliation');
      }
    }
    const rawUsage = operation.kind === 'agent'
      ? result.usage
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageSource: 'authoritative' as const };
    const normalizedUsage = rawUsage ? normalizeTokenUsage(rawUsage) : null;
    const source = usageSourceOf(normalizedUsage);
    const estimatedRequiresReconciliation = source === 'estimated' && !options.reconciled;
    const missingUsage = !normalizedUsage
      || (source === 'unknown' && !options.reconciled)
      || (estimatedRequiresReconciliation && !unknownUsageIsNonBlocking(this.store, operation.instanceId));
    const unknownUsageAllowed = missingUsage && unknownUsageIsNonBlocking(this.store, operation.instanceId);
    if (missingUsage && !unknownUsageAllowed) {
      recordConversationOutput(this.store, operation, result);
      this.store.db.prepare("UPDATE operations SET state='unknown',worker_active=0,result=? WHERE id=?")
        .run(canonicalJson(result), operation.id);
      this.store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?")
        .run(operation.taskId, operation.nodeId);
      this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND kind='recovery' AND status='open'")
        .run(canonicalJson({ result }), operation.id);
      closeUserWaitForOperation(this.store, operation.id);
      if (!this.store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'").get(operation.id)) {
        const reason = source === 'estimated'
          ? 'Agent returned only estimated usage for a finite budget'
          : 'Agent returned no accountable usage';
        insertQuestion(this.store, {
          taskId: operation.taskId,
          nodeId: operation.nodeId,
          operationId: operation.id,
          kind: 'unknown_usage',
          data: { reason, usageSource: source },
        });
        this.store.event(operation.taskId, 'operation.unknown', { operationId: operation.id, reason: 'unknown_usage', usageSource: source });
      }
      return;
    }
    if (missingUsage) {
      this.store.event(operation.taskId, 'operation.usage_unknown', {
        operationId: operation.id,
        nodeId: operation.nodeId,
        policy: 'non_blocking_unlimited',
        usageSource: source,
      });
    }
    const usage = missingUsage ? null : normalizedUsage;
    const values = usage ? [usage.input, usage.output, usage.cacheRead, usage.cacheWrite] : [];
    const total = values.reduce((sum, value) => sum + value, 0);
    if (usage && (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(total))) {
      throw new RuntimeError('invalid_usage', 'Invalid disjoint token counts');
    }
    const proposalRow = this.store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?')
      .get(operation.taskId, operation.proposalVersion) as { spec: string } | undefined;
    const proposal = proposalRow
      ? JSON.parse(proposalRow.spec) as Proposal
      : { requirementVersion: 1, summary: '', acceptance: [] as Proposal['acceptance'], nodes: [] as Proposal['nodes'] };
    const nodeSpec = JSON.parse((this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?')
      .get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
    if (new Set(result.artifacts?.map(artifact => artifact.id)).size !== (result.artifacts?.length ?? 0)
      || result.artifacts?.some(artifact => !artifact.id.trim() || !isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.digest)
        || ((artifact.artifactId === undefined) !== (artifact.version === undefined))
        || (artifact.artifactId !== undefined && (!artifact.artifactId.trim() || typeof artifact.version !== 'number' || !Number.isSafeInteger(artifact.version) || artifact.version < 1)))) {
      throw new RuntimeError('invalid_evidence', 'Artifacts require unique IDs, absolute paths and SHA-256 digests');
    }
    if (result.outcome === 'skipped' && !nodeSpec.optional) {
      throw new RuntimeError('invalid_result', 'Only a predeclared optional node may skip work');
    }
    if ((nodeSpec.routes && result.outcome === 'completed' && !nodeSpec.routes.includes(result.route!))
      || (result.route !== undefined && !nodeSpec.routes?.includes(result.route))) {
      throw new RuntimeError('invalid_result', 'Router must return a declared case');
    }
    result = settleResultHandoff(this.store, operation, proposal, result);
    const handoffFailure = resultHandoffFailure(result);
    if (handoffFailure) {
      for (const target of resultHandoffDependents(proposal, operation.nodeId)) {
        const data = {
          reason: handoffFailure.reason,
          code: 'context_rejected',
          sourceNodeId: operation.nodeId,
          sourceOperationId: operation.id,
          policy: 'result_handoff',
        };
        const existing = this.store.db.prepare(
          "SELECT id FROM questions WHERE task_id=? AND node_id=? AND kind='context_rejected' AND status='open'",
        ).get(operation.taskId, target);
        this.store.event(operation.taskId, 'context.result_handoff_missing', {
          nodeId: target,
          sourceNodeId: operation.nodeId,
          sourceOperationId: operation.id,
          reason: handoffFailure.reason,
        });
        this.store.event(operation.taskId, 'context.handoff_rejected', {
          nodeId: target,
          sourceNodeId: operation.nodeId,
          sourceOperationId: operation.id,
          reason: handoffFailure.reason,
        });
        this.store.event(operation.taskId, 'context.rejected', { nodeId: target, ...data });
        if (!existing) this.block(operation.taskId, target, 'context_rejected', data);
      }
    }
    const rework = result.outcome === 'completed' && isReworkDecision(result.output);
    if (result.outcome === 'completed' && !rework && proposal.acceptance.some(item =>
      item.checkNode === operation.nodeId && !result.evidence?.some(evidence => evidence.acceptanceId === item.id))) {
      throw new RuntimeError('invalid_evidence', 'Completed check is missing required acceptance evidence');
    }
    if (rework && result.evidence?.length) throw new RuntimeError('invalid_evidence', 'Rework cannot carry acceptance evidence');
    if (result.evidence?.length && result.outcome !== 'completed') {
      throw new RuntimeError('invalid_evidence', 'Only a completed check may produce acceptance evidence');
    }
    for (const evidence of result.evidence ?? []) {
      if (operation.kind !== 'program'
        || !proposal.acceptance.some(item => item.id === evidence.acceptanceId && item.checkNode === operation.nodeId)) {
        throw new RuntimeError('invalid_evidence', 'Evidence must come from the assigned program check');
      }
      if (!evidence.summary.trim() || !isAbsolute(evidence.artifact.path) || !/^[a-f0-9]{64}$/.test(evidence.artifact.digest)
        || ((evidence.artifact.artifactId === undefined) !== (evidence.artifact.version === undefined))
        || (evidence.artifact.artifactId !== undefined && (!evidence.artifact.artifactId.trim() || typeof evidence.artifact.version !== 'number' || !Number.isSafeInteger(evidence.artifact.version) || evidence.artifact.version < 1))) {
        throw new RuntimeError('invalid_evidence', 'Evidence requires a summary, absolute artifact path and SHA-256 digest');
      }
      this.store.db.prepare(`INSERT INTO evidence(
        id,task_id,node_id,operation_id,acceptance_id,proposal_version,requirement_version,data,activation_id,commit_sha
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(),
        operation.taskId,
        operation.nodeId,
        operation.id,
        evidence.acceptanceId,
        operation.proposalVersion,
        operation.requirementVersion,
        canonicalJson(evidence),
        operation.activationId,
        this.store.task(operation.taskId).integration_sha,
      );
    }
    this.store.db.prepare(`UPDATE operations
      SET state='succeeded',worker_active=0,result=?,usage=?,settled_at=COALESCE(settled_at,?)
      WHERE id=?`).run(canonicalJson(result), usage ? canonicalJson(usage) : null, Date.now(), operation.id);
    releaseOperationReservation(this.store, operation.id);
    if (operation.instanceId && usage) {
      commitUsage(this.store, operation.instanceId, total);
      recordCurrentModelUse(this.store, operation.instanceId);
    }
    this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'")
      .run(canonicalJson({ result }), operation.id);
    closeUserWaitForOperation(this.store, operation.id);
    const autoApprovedPermission = result.outcome === 'waiting'
      && Boolean(result.question?.grant)
      && operation.accessPolicy?.autoApprove.permission === true;
    if (result.outcome === 'waiting') {
      if (!result.question?.prompt.trim()) throw new RuntimeError('invalid_result', 'Waiting requires a question');
      if (result.question.grant) {
        this.block(operation.taskId, operation.nodeId, 'permission', { grant: result.question.grant }, operation.id);
      } else {
        this.block(
          operation.taskId,
          operation.nodeId,
          'waiting',
          result.question.data ?? { prompt: result.question.prompt },
          operation.id,
        );
      }
    }
    const conversation = nodeSpec.role === 'master' && operation.kind === 'agent'
      ? conversationForTask(this.store, operation.taskId)
      : undefined;
    recordConversationOutput(this.store, operation, result);
    const queuedAfter = conversation ? pendingMessages(this.store, conversation.id, 1).length : 0;
    const nextStatus = autoApprovedPermission
      ? 'pending'
      : conversation && result.outcome === 'completed' && queuedAfter
      ? 'pending'
      : result.outcome === 'completed'
        ? 'succeeded'
        : result.outcome === 'continue'
          ? 'pending'
          : result.outcome;
    this.store.db.prepare(`UPDATE nodes
      SET status=?,output=?,route=?,output_version=output_version+1,output_operation=?
      WHERE task_id=? AND id=?`).run(
      nextStatus,
      canonicalJson(result.output),
      result.route ?? null,
      operation.id,
      operation.taskId,
      operation.nodeId,
    );
    if (result.outcome === 'failed' && !nodeSpec.optional) {
      this.block(operation.taskId, operation.nodeId, 'execution_failed', { output: result.output }, operation.id);
    }
    if (total > row.reserved) {
      this.block(operation.taskId, operation.nodeId, 'reservation_exceeded', {
        reserved: row.reserved,
        actual: total,
      }, operation.id);
    }
    this.store.event(operation.taskId, 'operation.result', { operationId: operation.id, result });
    this.store.db.prepare('UPDATE activations SET state=(SELECT status FROM nodes WHERE task_id=? AND id=?) WHERE id=?')
      .run(operation.taskId, operation.nodeId, operation.activationId);
    if (rework) {
      this.handleRework(operation, result);
    } else if (result.outcome === 'completed' && proposal.acceptance.some(item => item.checkNode === operation.nodeId)) {
      for (const loop of loadGraph(this.store, operation.taskId).plan.loops.filter(item => item.from === operation.nodeId)) {
        this.store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(operation.taskId, loop.to);
      }
    }
    this.hooks.advance(operation.taskId);
  }
}

export function operationSnapshots(
  store: TaskStore,
  taskId: string,
  query: { after?: string; limit?: number } = {},
) {
  const rows = query.limit !== undefined
    ? store.db.prepare(`SELECT * FROM operations
        WHERE task_id=? AND rowid>COALESCE((SELECT rowid FROM operations WHERE id=?),0)
        ORDER BY rowid LIMIT ?`).all(taskId, query.after ?? '', query.limit) as unknown as OperationDbRow[]
    : store.db.prepare('SELECT * FROM operations WHERE task_id=? ORDER BY rowid').all(taskId) as unknown as OperationDbRow[];
  return rows.map((row): OperationSnapshot => ({
    id: row.id,
    operation: operationFrom(row),
    state: row.state,
    reserved: row.reserved,
    workerActive: Boolean(row.worker_active),
    result: row.result ? JSON.parse(row.result) as OperationResult : null,
  }));
}

export function nodeOperationRuns(store: TaskStore, taskId: string, nodeId: string) {
  return (store.db.prepare(`SELECT id,state,reserved,worker_active,waiting_slot,result,usage,dispatched_at,settled_at,waiting_ms,activation_id
    FROM operations WHERE task_id=? AND node_id=? ORDER BY rowid`).all(taskId, nodeId) as unknown as OperationDbRow[])
    .map((row): OperationRun => {
      const waitingMs = row.waiting_ms ?? 0;
      const runMs = row.dispatched_at !== null && row.settled_at !== null
        ? Math.max(0, row.settled_at - row.dispatched_at - (row.waiting_slot ? Date.now() - row.dispatched_at : waitingMs))
        : null;
      return {
        id: row.id,
        state: row.state,
        activationId: row.activation_id,
        workerActive: Boolean(row.worker_active),
        waitingSlot: Boolean(row.waiting_slot),
        reserved: row.reserved,
        waitingMs,
        runMs,
        dispatchedAt: row.dispatched_at,
        settledAt: row.settled_at,
        result: row.result ? JSON.parse(row.result) as Json : null,
        usage: row.usage ? JSON.parse(row.usage) as Json : null,
      };
    });
}

export function markOperationCredentialWait(store: TaskStore, operationId: string, now = Date.now()) {
  store.db.prepare('UPDATE operations SET waiting_slot=1,waiting_since=COALESCE(waiting_since,?) WHERE id=?')
    .run(now, operationId);
}

export function finishOperationCredentialWait(store: TaskStore, operationId: string, now = Date.now()) {
  store.db.prepare(`UPDATE operations
    SET waiting_slot=0,waiting_ms=waiting_ms + MAX(0,?-COALESCE(waiting_since,?)),waiting_since=NULL
    WHERE id=?`).run(now, now, operationId);
}

export function clearOperationCredentialWait(store: TaskStore, operationId: string) {
  store.db.prepare('UPDATE operations SET waiting_slot=0 WHERE id=?').run(operationId);
}
