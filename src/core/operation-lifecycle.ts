import { KernelStore } from './kernel-store.ts';
import { pendingRsiContinuation, releaseRsiContinuation } from './rsi-continuation.ts';
import { consumeWakes, releaseWakes, pendingWakes, wakeForAnswer } from './wake-ledger.ts';
import { retryDecision, MAX_TRANSIENT_RETRIES } from './transient-retry.ts';
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
import { canonicalJson, type TaskStore } from './store.ts';
import { closeUserWait, closeUserWaitForOperation } from './time-ledger.ts';
import { assertQuestionAnswer, insertQuestion } from './question-routing.ts';
import { isFullAccess } from './access-policy.ts';
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

/**
 * What an `operation.intent` event carries: enough to identify the operation in a timeline,
 * and nothing else.
 *
 * The `operations` row already stores the whole operation as its spec - including the input,
 * the dependency snapshot and the frozen context, which are the large parts - so writing the
 * same object into the event log stored every spec twice. `specRef` names where the rest of
 * it lives, for a reader that needs more than the identity.
 */
export function operationIntentEvent(operation: Operation): Record<string, unknown> {
  return {
    operationId: operation.id,
    taskId: operation.taskId,
    nodeId: operation.nodeId,
    instanceId: operation.instanceId,
    generation: operation.generation,
    attempt: operation.attempt,
    kind: operation.kind,
    action: operation.action,
    proposalVersion: operation.proposalVersion,
    requirementVersion: operation.requirementVersion,
    specRef: 'operations.spec',
  };
}

export interface OperationSnapshot {
  id: string;
  operation: Operation;
  state: string;
  reserved: number;
  workerActive: boolean;
  result: OperationResult | null;
  dispatchedAt: number | null;
  settledAt: number | null;
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
  canReplayBeforeSend?(operation: Operation): boolean;
}

function operationFrom(row: OperationDbRow) {
  return JSON.parse(row.spec) as Operation;
}

/**
 * The words a failed operation left behind, flattened for the environment-failure predicate.
 * A failure arrives as `{error}`, as a command's `{stdout,stderr}`, or as a bare value; the
 * predicate matches text, so every shape has to reach it rather than only the first one.
 */
function describeFailure(output: Json | undefined): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  if (typeof output !== 'object' || Array.isArray(output)) return JSON.stringify(output);
  const record = output as Record<string, unknown>;
  const parts = ['error', 'stderr', 'stdout', 'message', 'reason']
    .map(key => record[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return parts.length ? parts.join('\n') : JSON.stringify(output);
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

  constructor(store: TaskStore, hooks: OperationLifecycleHooks = {}) {
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
      dispatchedAt: row.dispatched_at,
      settledAt: row.settled_at,
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
          releaseMessages(this.store, row.id);
        } else {
          const operation = operationFrom(row);
          if (this.restoreUnsentConversation(row)) continue;
          if (isFullAccess(operation.accessPolicy)) {
            this.releaseFullAccessRecovery(row, 'Full access recovery released the uncertain dispatch for retry');
            this.store.event(row.task_id, 'operation.recovery_bypassed', {
              operationId: row.id,
              policy: 'full_access',
            });
            continue;
          }
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
      // Heal messages stranded by the old full-access restart path. Only the
      // unanswered tail is eligible; never resurrect a request followed by a
      // settled turn or an open problem. The adapter must still prove no send.
      const stranded = this.store.db.prepare(`WITH candidates AS MATERIALIZED (
        SELECT DISTINCT o.* FROM operations o
        JOIN messages m ON m.operation_id=o.id AND m.role='user' AND m.state='delivered'
        JOIN tasks t ON t.id=o.task_id
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        WHERE o.state='not_sent' AND t.phase='chatting' AND n.status IN ('pending','failed')
          AND o.activation_id=n.activation_id)
        SELECT o.* FROM candidates o WHERE NOT EXISTS (SELECT 1 FROM operations later WHERE later.task_id=o.task_id AND later.node_id=o.node_id
            AND later.rowid>(SELECT rowid FROM operations WHERE id=o.id) AND (later.state!='not_sent' OR later.result IS NOT NULL))
          AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=o.task_id AND e.type='operation.recovery_bypassed'
            AND json_extract(e.data,'$.operationId')=o.id)`)
        .all() as unknown as OperationDbRow[];
      for (const row of stranded) this.restoreUnsentConversation(row);
      // Rows already marked unknown by an earlier process can keep a stale
      // worker flag as well (for example after a crash during reconciliation).
      this.store.db.prepare("UPDATE operations SET worker_active=0 WHERE state='unknown' AND worker_active=1").run();
      return generation;
    });
  }

  private restoreUnsentConversation(row: OperationDbRow): boolean {
    const task = this.store.task(row.task_id);
    if (task.phase !== 'chatting' || task.paused || row.result) return false;
    const node = this.nodeRow(row.task_id, row.node_id);
    if ((JSON.parse(node.spec) as NodeSpec).role !== 'master' || node.activation_id !== row.activation_id) return false;
    const conversation = conversationForTask(this.store, row.task_id);
    if (!conversation || conversation.archived_at !== null) return false;
    if (this.store.db.prepare("SELECT 1 FROM questions WHERE task_id=? AND node_id=? AND status='open' LIMIT 1")
      .get(row.task_id, row.node_id)) return false;
    if (!this.store.db.prepare("SELECT 1 FROM messages WHERE operation_id=? AND role='user' AND state='delivered' LIMIT 1").get(row.id)) return false;
    if (this.hooks.canReplayBeforeSend?.(operationFrom(row)) !== true) return false;
    if (row.state === 'not_sent') {
      // A later turn may have read the earlier request from conversation
      // history. Old full-access recovery also called uncertain sends
      // not_sent, so that label alone cannot prove the entire tail is safe.
      const later = this.store.db.prepare(`SELECT spec FROM operations WHERE task_id=? AND node_id=?
        AND rowid>(SELECT rowid FROM operations WHERE id=?) ORDER BY rowid`);
      for (const next of later.iterate(row.task_id, row.node_id, row.id)) {
        if (this.hooks.canReplayBeforeSend?.(JSON.parse(next.spec as string) as Operation) !== true) return false;
      }
    }
    this.markNotSent(row, { resetNode: true, eventReason: 'Recovered conversation before adapter session/send' });
    releaseMessages(this.store, row.id);
    this.store.db.prepare("UPDATE activations SET state='pending' WHERE id=?").run(node.activation_id);
    this.store.event(row.task_id, 'conversation.turn_requeued', { operationId: row.id, reason: 'adapter_not_started' });
    return true;
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
      this.store.event(operation.taskId, 'operation.intent', operationIntentEvent(operation));
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
    releaseRsiContinuation(this.store, row.id);
    // A wake bound to a turn that never dispatched has to become deliverable again, or the
    // reason the master was woken is silently swallowed by an operation that never ran.
    releaseWakes(this.store, row.id);
    if (options.resetNode) {
      this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(row.task_id, row.node_id);
    }
    if (options.eventReason !== undefined) {
      this.store.event(row.task_id, 'operation.not_sent', { operationId: row.id, reason: options.eventReason });
    }
  }

  private releaseFullAccessRecovery(row: OperationDbRow, reason: string) {
    this.markNotSent(row, { resetNode: true, eventReason: reason });
    const node = this.nodeRow(row.task_id, row.node_id);
    const spec = JSON.parse(node.spec) as NodeSpec;
    const conversation = spec.role === 'master' && this.store.task(row.task_id).phase === 'chatting'
      ? conversationForTask(this.store, row.task_id) : undefined;
    // An uncertain turn already consumed its message. Do not turn it into a
    // fresh request; explicit recovery can still set the master pending later.
    if (conversation && !pendingMessages(this.store, conversation.id, 1).length
      && !pendingRsiContinuation(this.store, row.task_id, row.node_id)) {
      this.store.db.prepare("UPDATE nodes SET status='failed' WHERE task_id=? AND id=?").run(row.task_id, row.node_id);
      this.store.db.prepare("UPDATE activations SET state='failed' WHERE id=?").run(node.activation_id);
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
      recordConversationInterruption(this.store, operationFrom(row), reason, 'setup');
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
      if (operation.context.rsiContinuation) this.store.event(operation.taskId, 'rsi.continuation_dispatched', {
        requestId: operation.context.rsiContinuation.requestId, operationId: operation.id,
      });
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

  async steer(operationId: string, steer: (operation: Operation) => Promise<{ ordinal?: number } | void>) {
    const row = this.operationRow(operationId);
    if (row.state !== 'dispatched' || !row.worker_active) {
      throw new RuntimeError('no_active_operation', 'The master Agent is no longer accepting steering messages');
    }
    return await steer(operationFrom(row));
  }

  async interrupt(operationId: string, interrupt: (operation: Operation) => Promise<{ ordinal?: number } | void>) {
    const row = this.operationRow(operationId);
    if (row.state !== 'dispatched' || !row.worker_active) {
      throw new RuntimeError('no_active_operation', 'The master Agent is no longer accepting interruption');
    }
    return await interrupt(operationFrom(row));
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
    const refusalCodes = ['paused', 'budget', 'unknown_usage', 'context_rejected', 'interrupted'];
    if (!refusalCodes.includes(error.code)) return false;
    if (isFullAccess(operation.accessPolicy) && error.code !== 'interrupted') {
      return this.transaction(() => {
        const row = this.operationRow(operation.id);
        if (!['dispatched', 'unknown'].includes(row.state)) return false;
        this.markNotSent(row, {
          resetNode: true,
          eventReason: `Full access bypassed ${error.code}: ${error.message}`,
        });
        releaseMessages(this.store, operation.id);
        return true;
      });
    }
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
        const data = {
          reason: error.message,
          code: error.code,
          requiredFacts: [] as Json,
          policy: 'none',
        };
        this.store.event(operation.taskId, 'context.rejected', { nodeId: operation.nodeId, operationId: operation.id, ...data });
        this.block(operation.taskId, operation.nodeId, 'context_rejected', data, operation.id);
      } else if (error.code === 'interrupted') {
        this.store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?")
          .run(operation.taskId, operation.nodeId);
        recordConversationInterruption(this.store, operation, error.message);
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
      // Access policy grants capabilities; it cannot make an execution or
      // settlement exception safe to replay. Preserve the uncertain attempt
      // and route one recovery problem instead of spinning on the same error.
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
      assertQuestionAnswer(question.kind, answer);
      if (question.kind === 'budget' && answer.type === 'add_budget') {
        if (!Number.isSafeInteger(answer.tokens) || answer.tokens <= 0) {
          throw new RuntimeError('invalid_answer', 'A positive token increment is required');
        }
        const kernel = new KernelStore(this.store);
        if (kernel.latestRevision(taskId)) {
          const data = JSON.parse(question.data) as { executionId?: string };
          const execution = data.executionId ? kernel.execution(data.executionId) : null;
          if (!execution || execution.taskId !== taskId || execution.nodeId !== question.node_id || !execution.tokenBudget) {
            throw new RuntimeError('invalid_answer', 'Budget question has no frozen execution quota');
          }
          const quota = kernel.authorizedBudget(taskId, question.node_id) ?? execution.tokenBudget;
          if (quota.unlimited || !Number.isSafeInteger(quota.budget + answer.tokens)) {
            throw new RuntimeError('invalid_answer', 'Budget increment requires a finite quota within the safe integer range');
          }
          kernel.setAuthorizedBudget(taskId, question.node_id, quota.budget + answer.tokens);
          this.store.event(taskId, 'instance.budget_changed', { nodeId: question.node_id, tokens: quota.budget + answer.tokens, nextExecution: true });
        } else {
          const instance = this.store.db.prepare('SELECT id FROM instances WHERE task_id=? AND node_id=?')
            .get(taskId, question.node_id) as { id: string };
          addBudget(this.store, instance.id, answer.tokens);
        }
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
      } else if (question.kind === 'human_check' && answer.type === 'reject') {
        // A human rejection is a verdict, not an obstacle to clear: the acceptance did not pass, so the
        // node stays blocked and the main Agent gets a rework problem carrying the user's reason.
        const data = JSON.parse(question.data) as { prompt?: string };
        insertQuestion(this.store, {
          taskId,
          nodeId: question.node_id,
          kind: 'rework',
          data: {
            prompt: 'A human acceptance check was rejected and must be reworked',
            reason: answer.reason ?? null,
            rejected: data.prompt ?? null,
          } as Json,
        });
        this.store.event(taskId, 'human.rejected', { questionId, nodeId: question.node_id, reason: answer.reason ?? null });
      }
      if (question.kind === 'human_check' && answer.type === 'acknowledge') {
        // "The user passed the human check" has to exist as an event: without it the
        // only trace of a passed acceptance is an answered question, and the master
        // cannot tell a pass from a rejection by looking at the stream.
        this.store.event(taskId, 'human.accepted', { questionId, nodeId: question.node_id });
      }
      this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?").run(canonicalJson(answer), questionId);
      closeUserWait(this.store, taskId, question.node_id);
      // An answered question the graph depends on is a fact the conversation's master
      // has to act on, or the graph would sit still with nobody reading the answer.
      wakeForAnswer(this.store, taskId, {
        questionId, nodeId: question.node_id, kind: question.kind, answer: answer as unknown as Json,
      });
      // Native graphs preserve the same human answer and wake records, but have no
      // legacy nodes/activations to resume. Their accepted queues stay under main control.
      if (this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_revisions'").get()
        && this.store.db.prepare('SELECT 1 FROM kernel_revisions WHERE task_id=? LIMIT 1').get(taskId)) {
        const open = this.store.db.prepare("SELECT 1 FROM questions WHERE task_id=? AND status='open' LIMIT 1").get(taskId);
        if (!open) this.store.db.prepare(`UPDATE tasks SET phase='completing' WHERE id=? AND phase='blocked'
          AND EXISTS(SELECT 1 FROM kernel_lifecycle WHERE task_id=? AND completion_requested=1)`).run(taskId, taskId);
        return;
      }
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
        const rejected = question.kind === 'human_check' && answer.type === 'reject';
        this.store.db.prepare('UPDATE nodes SET status=? WHERE task_id=? AND id=?')
          .run(rejected ? 'blocked' : question.kind === 'system_change' || !completed || queued ? 'pending' : 'succeeded', taskId, question.node_id);
      }

    });
  }

  /**
   * Hand a main-owned problem to the user with the main Agent's explanation.
   * The node stays blocked until the user answers; the answer then becomes part
   * of the next attempt's context, so the worker receives the missing decision.
   */
  escalate(taskId: string, questionId: string, prompt: string) {
    this.transaction(() => {
      const row = this.store.db.prepare(`SELECT node_id,kind,data FROM questions
        WHERE id=? AND task_id=? AND status='open'`).get(questionId, taskId) as
        { node_id: string; kind: string; data: string } | undefined;
      if (!row) throw new RuntimeError('invalid_question', 'No open question in this task');
      const source = JSON.parse(row.data) as Json;
      this.store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?")
        .run(canonicalJson({ type: 'escalated', prompt }), questionId);
      const escalated = insertQuestion(this.store, {
        taskId,
        nodeId: row.node_id,
        kind: 'waiting',
        data: {
          requestType: 'noncompliance_decision',
          prompt,
          escalatedFrom: row.kind,
          defects: (source as Record<string, Json> | null)?.defects ?? [],
        } as Json,
      });
      this.store.event(taskId, 'problem.escalated', {
        questionId,
        nodeId: row.node_id,
        kind: row.kind,
        escalatedTo: escalated.id,
      });
    });
  }

  /**
   * Resolve the `context_rejected` problems an earlier handoff failure created
   * on the dependents of this node, once the handoff they were missing exists.
   */
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
    const fullAccess = isFullAccess(operation.accessPolicy);
    // Decide a transient retry BEFORE usage accounting: a failure the environment caused is going
    // to be re-run, so the question "was this turn's usage accountable?" is moot and must not become
    // the thing main is woken for. Real ledger: `execution_failed` was answered `retry` 105 times,
    // about 101 of them a blip. `stall_count` is the per-node attempt counter a manual retry already
    // clears, so this reuses it instead of adding a column.
    if (result.outcome === 'failed') {
      if (!this.store.db.prepare('SELECT id FROM questions WHERE task_id=? AND node_id=? AND status=\'open\'')
        .get(operation.taskId, operation.nodeId)) {
        const attempt = (this.store.db.prepare('SELECT stall_count FROM nodes WHERE task_id=? AND id=?')
          .get(operation.taskId, operation.nodeId) as { stall_count: number } | undefined)?.stall_count ?? 0;
        const decision = retryDecision({ output: describeFailure(result.output), attempt: attempt + 1 });
        if (decision.retry) {
          this.store.db.prepare('UPDATE operations SET state=\'settled\',worker_active=0,result=? WHERE id=?')
            .run(canonicalJson(result), operation.id);
          this.store.db.prepare("UPDATE nodes SET status='pending',output=?,stall_count=stall_count+1,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?")
            .run(canonicalJson(result.output), operation.id, operation.taskId, operation.nodeId);
          this.store.db.prepare("UPDATE activations SET state='pending',round=round+1 WHERE id=?").run(operation.activationId);
          this.store.event(operation.taskId, 'node.transient_retry', {
            nodeId: operation.nodeId, attempt: decision.attempt, reason: decision.reason, operationId: operation.id,
          });
          // The activation returns to pending so the scheduler dispatches the node again with
          // nobody woken and no usage question raised.
          return;
        }
      }
    }
    const missingUsage = !fullAccess && (!normalizedUsage
      || (source === 'unknown' && !options.reconciled)
      || (estimatedRequiresReconciliation && !unknownUsageIsNonBlocking(this.store, operation.instanceId)));
    const unknownUsageAllowed = fullAccess || (missingUsage && unknownUsageIsNonBlocking(this.store, operation.instanceId));
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
    if (fullAccess && (!normalizedUsage || source === 'unknown')) {
      this.store.event(operation.taskId, 'operation.usage_unknown', {
        operationId: operation.id,
        nodeId: operation.nodeId,
        policy: 'non_blocking_full_access',
        usageSource: source,
      });
    }
    if (missingUsage) {
      this.store.event(operation.taskId, 'operation.usage_unknown', {
        operationId: operation.id,
        nodeId: operation.nodeId,
        policy: fullAccess ? 'non_blocking_full_access' : 'non_blocking_unlimited',
        usageSource: source,
      });
    }
    const usage = missingUsage ? null : normalizedUsage;
    const values = usage ? [usage.input, usage.output, usage.cacheRead, usage.cacheWrite] : [];
    const total = values.reduce((sum, value) => sum + value, 0);
    if (usage && (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(total))) {
      throw new RuntimeError('invalid_usage', 'Invalid disjoint token counts');
    }
    const nodeSpec = JSON.parse((this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?')
      .get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
    if (new Set(result.artifacts?.map(artifact => artifact.id)).size !== (result.artifacts?.length ?? 0)
      || result.artifacts?.some(artifact => !artifact.id.trim() || !isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.digest)
        || ((artifact.artifactId === undefined) !== (artifact.version === undefined))
        || (artifact.artifactId !== undefined && (!artifact.artifactId.trim() || typeof artifact.version !== 'number' || !Number.isSafeInteger(artifact.version) || artifact.version < 1)))) {
      throw new RuntimeError('invalid_evidence', 'Artifacts require unique IDs, absolute paths and SHA-256 digests');
    }
    if (result.outcome === 'skipped') {
      throw new RuntimeError('invalid_result', 'Main execution cannot skip work');
    }
    this.store.db.prepare(`UPDATE operations
      SET state='succeeded',worker_active=0,result=?,usage=?,settled_at=COALESCE(settled_at,?)
      WHERE id=?`).run(canonicalJson(result), usage ? canonicalJson(usage) : null, Date.now(), operation.id);
    this.bindWakes(operation);
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
      SET status=?,output=?,route=NULL,output_version=output_version+1,output_operation=?
      WHERE task_id=? AND id=?`).run(
      nextStatus,
      canonicalJson(result.output),
      operation.id,
      operation.taskId,
      operation.nodeId,
    );
    if (result.outcome === 'failed') {
      // The retry decision was already made above (before usage accounting). Reaching here means
      // the failure is main's: either a verdict, an unexplained failure, or an exhausted bound -
      // and the problem says which, so main is not handed a bare failure.
      const attempt = (this.store.db.prepare('SELECT stall_count FROM nodes WHERE task_id=? AND id=?')
        .get(operation.taskId, operation.nodeId) as { stall_count: number } | undefined)?.stall_count ?? 0;
      const decision = retryDecision({ output: describeFailure(result.output), attempt: attempt + 1 });
      this.block(operation.taskId, operation.nodeId, 'execution_failed', {
        output: result.output,
        ...(decision.exhausted ? { transientRetriesExhausted: MAX_TRANSIENT_RETRIES } : {}),
        retryVerdict: decision.reason,
      }, operation.id);
    }
    if (!fullAccess && total > row.reserved) {
      this.block(operation.taskId, operation.nodeId, 'reservation_exceeded', {
        reserved: row.reserved,
        actual: total,
      }, operation.id);
    }
    this.store.event(operation.taskId, 'operation.result', { operationId: operation.id, result });
    this.store.db.prepare('UPDATE activations SET state=(SELECT status FROM nodes WHERE task_id=? AND id=?) WHERE id=?')
      .run(operation.taskId, operation.nodeId, operation.activationId);

  }

  /**
   * Bind ready wakes to the turn that is about to act on them.
   *
   * Consuming at preparation time is what makes "delivered" and "acted on" the same
   * event: a turn that never dispatches releases them again, so the master is woken
   * by the next ready turn instead of the reason being lost.
   */
  private bindWakes(operation: Operation) {
    const ready = pendingWakes(this.store, operation.taskId, operation.nodeId);
    if (!ready.length) return;
    consumeWakes(this.store, operation.taskId, operation.nodeId, operation.id);
    this.store.event(operation.taskId, 'wake.delivered', {
      operationId: operation.id,
      kinds: ready.map(wake => wake.kind),
      dedupeKeys: ready.map(wake => wake.dedupeKey),
    });
  }
}

export interface OperationQuery {
  after?: string;
  before?: string;
  latest?: boolean;
  nodeId?: string;
  limit?: number;
}

export function operationSnapshots(store: TaskStore, taskId: string, query: OperationQuery = {}) {
  const filters = ['task_id=?'];
  const params: (string | number)[] = [taskId];
  if (query.nodeId !== undefined) { filters.push('node_id=?'); params.push(query.nodeId); }
  if (query.after !== undefined || query.before !== undefined) {
    const before = query.before !== undefined;
    filters.push(`rowid${before ? '<' : '>'}COALESCE((SELECT rowid FROM operations WHERE task_id=? AND id=?),0)`);
    params.push(taskId, before ? query.before! : query.after!);
  }
  const descending = query.before !== undefined || (query.latest && query.after === undefined);
  const limit = query.limit === undefined ? '' : ' LIMIT ?';
  if (query.limit !== undefined) params.push(query.limit);
  const rows = store.db.prepare(`SELECT * FROM operations WHERE ${filters.join(' AND ')}
    ORDER BY rowid ${descending ? 'DESC' : 'ASC'}${limit}`).all(...params) as unknown as OperationDbRow[];
  if (descending) rows.reverse();
  return rows.map((row): OperationSnapshot => ({
    id: row.id,
    operation: operationFrom(row),
    state: row.state,
    reserved: row.reserved,
    workerActive: Boolean(row.worker_active),
    result: row.result ? JSON.parse(row.result) as OperationResult : null,
    dispatchedAt: row.dispatched_at,
    settledAt: row.settled_at,
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
