import { RuntimeError, type Json } from './types.ts';
import type { KernelStore, QueueRow } from './kernel-store.ts';

/**
 * One serial queue per node (Issue #1 §7, §14, §15.3).
 *
 * A node processes chat and interface input in ACCEPTANCE order, and at most one
 * execution runs at a time. A chat accepted while a turn is running is queued —
 * never injected into the running turn. A failed node pauses its OWN queue while
 * independent nodes keep draining.
 *
 * Retry counters live in the durable store (`kernel_node_state`), so a process
 * restart does not reset them: the confirmed default is at most 2 automatic
 * retries after an unsubmitted failure (3 attempts total), and at most 1 automatic
 * resubmit for a missing required output. The two are counted separately.
 */

/** The confirmed defaults (§15.3). */
export const DEFAULT_RETRIES = 2;
export const DEFAULT_RESUBMITS = 1;

export interface QueueInput {
  nodeId: string;
  /** 'delivery' is an interface input; 'chat' is a direct message to the node. */
  kind: 'delivery' | 'chat' | 'control';
  text?: string;
  input?: string;
  value?: Json;
  /**
   * When present, this input re-sends work for an execution that already
   * submitted successfully. §7 forbids re-sending the original input after a
   * successful submit, so the enqueue is refused.
   */
  originalOf?: string;
}

export interface RetryBudget {
  attempts: number;
  retriesAllowed: number;
  resubmitsAllowed: number;
  resubmitsUsed: number;
}

export type QueueCompletion =
  | { kind: 'submitted' }
  | { kind: 'failed'; reason: string };

export class NodeQueue {
  private readonly kernel: KernelStore;
  private readonly taskId: string;
  private readonly defaults: { defaultRetries?: number; defaultResubmits?: number };

  constructor(
    kernel: KernelStore,
    taskId: string,
    defaults: { defaultRetries?: number; defaultResubmits?: number } = {},
  ) {
    this.kernel = kernel;
    this.taskId = taskId;
    this.defaults = defaults;
  }

  /** Append one input; returns the accepted row. Refuses a re-send after a successful submit. */
  enqueue(input: QueueInput): QueueRow {
    if (input.originalOf) {
      const execution = this.kernel.execution(input.originalOf);
      if (execution?.submissionId) {
        throw new RuntimeError('invalid_queue', `Execution ${input.originalOf} already submitted; the original input must not be re-sent`);
      }
    }
    const payload: Json = input.kind === 'chat'
      ? { text: input.text ?? '' }
      : input.kind === 'control'
        ? { action: input.text ?? '', value: input.value ?? null }
        : { input: input.input ?? '', value: input.value ?? null };
    return this.kernel.enqueue(this.taskId, { nodeId: input.nodeId, kind: input.kind, payload });
  }

  /** The oldest queued item for a node, or null when the node is paused or empty. */
  next(nodeId: string): QueueRow | null {
    if (this.paused(nodeId)) return null;
    return this.kernel.nextQueued(this.taskId, nodeId);
  }

  /** Claim the node's next item and run it as the node's one execution. */
  claim(nodeId: string): QueueRow | null {
    if (this.paused(nodeId)) return null;
    // §7: at most one execution per node at a time. A claimed item means the node
    // is busy, so no second item may be claimed until it settles.
    const busy = this.kernel.db.prepare("SELECT 1 FROM kernel_queue WHERE task_id=? AND node_id=? AND state='claimed' LIMIT 1").get(this.taskId, nodeId);
    if (busy) return null;
    const next = this.kernel.nextQueued(this.taskId, nodeId);
    if (!next) return null;
    return this.kernel.claimQueued(this.taskId, next.seq);
  }

  /** A successful submit settles the item; a failure marks it failed and pauses the node's queue. */
  complete(seq: number, outcome: QueueCompletion): void {
    const nodeRow = this.kernel.db.prepare('SELECT node_id FROM kernel_queue WHERE task_id=? AND seq=?').get(this.taskId, seq) as { node_id: string } | undefined;
    if (!nodeRow) throw new RuntimeError('invalid_queue', `Unknown queue item ${seq}`);
    if (outcome.kind === 'submitted') {
      this.kernel.finishQueued(this.taskId, seq, 'done');
      return;
    }
    this.kernel.finishQueued(this.taskId, seq, 'failed');
    // A failed node pauses its own queue; independent nodes continue.
    this.kernel.setNodeQueuePaused(this.taskId, nodeRow.node_id, true);
  }

  paused(nodeId: string): boolean {
    return this.kernel.nodeState(this.taskId, nodeId).paused;
  }

  /** Reopen a paused node queue (main agent action, or a resolved failure). */
  resume(nodeId: string): void {
    this.kernel.setNodeQueuePaused(this.taskId, nodeId, false);
  }

  /** The node's retry budget: graph defaults, overridable per node; never reset by a restart. */
  retryBudget(nodeId: string): RetryBudget {
    const state = this.kernel.nodeState(this.taskId, nodeId);
    return {
      attempts: state.attempts,
      retriesAllowed: state.retriesAllowed ?? this.defaults.defaultRetries ?? DEFAULT_RETRIES,
      resubmitsAllowed: state.resubmitsAllowed ?? this.defaults.defaultResubmits ?? DEFAULT_RESUBMITS,
      resubmitsUsed: state.resubmitsUsed,
    };
  }

  /** Count one attempt. Called before each execution so the count survives a crash. */
  noteAttempt(nodeId: string): void {
    this.kernel.noteNodeAttempt(this.taskId, nodeId);
  }

  /** Count one automatic resubmit; refused once the budget is spent. */
  noteResubmit(nodeId: string): void {
    this.kernel.noteNodeResubmit(this.taskId, nodeId, this.retryBudget(nodeId).resubmitsAllowed);
  }

  /** A per-node override of the graph default retry budget. */
  configure(nodeId: string, config: { retriesAllowed?: number; resubmitsAllowed?: number }): void {
    this.kernel.configureNodeRetries(this.taskId, nodeId, config);
  }
}
