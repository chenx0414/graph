import { occupiedSlots, executionLimit } from '../runtime/execution-slots.ts';
import type { KernelStore, QueueRow } from './kernel-store.ts';
import type { ArtifactWorkspace } from './artifact-workspace.ts';
import { NodeQueue } from './node-queue.ts';
import { settleDeliverable } from './node-deliverable.ts';
import { RuntimeError } from './types.ts';

/**
 * The node execution loop (Issue #1 §7, §8; backlog HB-252).
 *
 * `ResidentHost` owns the process; `NodeQueue` owns what is waiting and the retry
 * counters. This is the driver that ties them together for one node: it claims the
 * oldest queued item, opens ONE execution, and turns the resident worker until the
 * execution reaches a terminal state.
 *
 * Two failure kinds are counted separately (§7):
 *
 *   - a turn that ends without a valid submission is a RETRY: the same execution is
 *     turned again, up to the node's retry budget;
 *   - a submission the kernel refused for a missing required output is a RESUBMIT:
 *     the gap is injected back into the SAME execution as a structured turn, and
 *     the execution is NOT restarted, because the node's own work is still valid.
 *
 * When either budget is spent the node fails and its queue pauses — the queue, not
 * the graph, so independent nodes keep running while the main agent decides.
 */

/** The subset of `ResidentHost` this loop depends on, so a test can supply a fake. */
export interface ExecutorHost {
  start(): Promise<{ processId: number }>;
  alive(): boolean;
  /**
   * `usage` is what the turn cost (§9). Optional because not every transport reports it,
   * and an absent figure must stay absent rather than become zero: "unknown" and "free"
   * are different facts to a budget.
   */
  turn(text: string): Promise<{ turnId: string; inspect: unknown; usage?: { total: number; accounted?: boolean } | undefined }>;
}

/** What a turn reported back: a missing-required gap, or nothing when it submitted. */
export interface TurnReport {
  error?: string;
  done?: boolean;
  missing?: string[];
  /** What this turn cost (§9), when the transport reported it. */
  usage?: { total: number; accounted?: boolean } | undefined;
}

/** Runs one attempt of a node's execution and reports any missing-required gap. */
export type TurnRunner = (
  executionId: string,
  attempt: number,
  injection: { missing: string[] } | undefined,
  input?: QueueRow,
) => Promise<TurnReport | void>;

export interface NodeExecutorOptions {
  maxItems?: number;
  signal?: AbortSignal;
  kernel: KernelStore;
  graphId: string;
  /** The node's resident host. The host owns the worker config and the process, so the
   * executor does not carry them: spawning is not its business (Issue #1 §7). */
  host: ExecutorHost | ((executionId: string, revisionVersion: number) => Promise<ExecutorHost>);
  /** The node's workspace, where a declared deliverable must exist. */
  workspace?: () => string | undefined;
  /** The artifact store a declared deliverable is published to. */
  artifacts?: () => ArtifactWorkspace | undefined;
  /**
   * §9: this node's token budget, and how much one turn is expected to cost.
   *
   * A turn is reserved before it starts and the hold is released when the execution
   * settles. Without it a v2 node had no ceiling at all: the old ledger is keyed on
   * `instances`, which a v2 node cannot have a row in.
   *
   * Absent means unmetered - a program node, or a runtime that was never given limits.
   */
  tokenBudget?: { budget: number; unlimited: boolean };
  reserveTokens?: number;
}

export type NodeOutcome = 'done' | 'failed' | 'idle' | 'blocked';

export class NodeExecutor {
  private readonly queue: NodeQueue;
  private readonly kernel: KernelStore;
  private readonly graphId: string;

  private readonly options: NodeExecutorOptions;

  constructor(options: NodeExecutorOptions) {
    this.options = options;
    this.kernel = options.kernel;
    this.graphId = options.graphId;
    this.queue = new NodeQueue(options.kernel, options.graphId);
  }

  /** True when the node already has a submission recorded for its newest execution. */
  private hasValidSubmission(executionId: string): boolean {
    const row = this.kernel.db.prepare('SELECT 1 FROM kernel_submissions WHERE execution_id=? LIMIT 1').get(executionId);
    return row !== undefined;
  }

  /**
   * Drain the node's queue until it is empty or the node pauses. `run` drives one
   * turn; production passes a function that turns the resident worker and lets the
   * node's submit land in the kernel, while tests pass a scripted stand-in.
   */
  async runNode(nodeId: string, run: TurnRunner): Promise<NodeOutcome> {
    let last: NodeOutcome = 'idle';
    let consumed = 0;
    for (;;) {
      // A node paused before its turn is never sent. The queued item stays, so resuming
      // runs it with nothing lost - this is a hold, not a cancellation.
      if (this.options.signal?.aborted || this.kernel.nodeState(this.graphId, nodeId).paused) return last;
      const task = this.kernel.store.task(this.graphId);
      if (task.paused || ['stopping', 'stopped', 'completed'].includes(task.phase)) return last;
      if (occupiedSlots(this.kernel.store, 'agent') >= executionLimit('agent')) return last;
      const item = this.queue.claim(nodeId);
      if (!item) return last;
      last = await this.runOne(nodeId, item, run);
      consumed += 1;
      if (last === 'failed' || last === 'blocked') return last;
      if (consumed >= (this.options.maxItems ?? Infinity)) return last;
    }
  }

  /** One queued item: one execution, turned until submit, failure, or budget spent. */
  private async runOne(nodeId: string, item: QueueRow, run: TurnRunner): Promise<NodeOutcome> {
    const seq = item.seq;
    const revision = this.kernel.latestRevision(this.graphId);
    if (!revision) throw new RuntimeError('invalid_graph', `Graph ${this.graphId} has no revision`);

    const generation = (this.kernel.db.prepare('SELECT generation FROM kernel_queue WHERE seq=?').get(seq) as { generation: number }).generation;
    const executionId = `exec-${this.graphId}-${nodeId}-${seq}${generation ? `-${generation}` : ''}`;
    this.kernel.startExecution(this.graphId, { executionId, nodeId, revisionVersion: revision.version });

    const budget = this.queue.retryBudget(nodeId);
    // §9: hold what this turn may cost before spending any of it. A node that cannot
    // afford the hold is parked rather than run unbudgeted.
    const metering = this.options.tokenBudget && this.options.reserveTokens !== undefined
      ? { limit: this.options.tokenBudget, amount: this.options.reserveTokens }
      : undefined;
    let host: ExecutorHost | undefined;
    let held = false;
    const releaseHold = () => {
      if (metering && held) { this.kernel.releaseNodeTokens(this.graphId, nodeId, metering.amount); held = false; }
    };
    const recovered = this.kernel.execution(executionId)!;
    let attempt = recovered.attempt;
    let retriesUsed = recovered.retriesUsed;
    let resubmitsUsed = recovered.resubmitsUsed;
    let injection: { missing: string[] } | undefined = recovered.pendingGap.length ? { missing: recovered.pendingGap } : undefined;

    for (;;) {
      if (metering) {
        try {
          this.kernel.reserveNodeTokens(this.graphId, nodeId, metering.limit, metering.amount);
          held = true;
        } catch (error) {
          if (!(error instanceof RuntimeError) || error.code !== 'budget') throw error;
          this.kernel.finishExecution(executionId, 'blocked');
          this.kernel.blockNode(this.graphId, nodeId, error.message);
          this.queue.complete(seq, { kind: 'blocked', reason: error.message });
          return 'blocked';
        }
      }
      attempt = this.kernel.noteExecutionAttempt(executionId);
      this.queue.noteAttempt(nodeId);
      // A crash rebuild keeps the same execution; the turn resumes against the
      // rebuilt process rather than starting a fresh one.
      let report: TurnReport | void;
      let turnStarted = false;
      try {
        host ??= typeof this.options.host === 'function' ? await this.options.host(executionId, revision.version) : this.options.host;
        if (!host.alive()) await host.start();
        turnStarted = true;
        report = await run(executionId, attempt, injection, item);
      } catch (error) {
        if (this.options.signal?.aborted) {
          const reason = 'Runtime closing; input retained without consuming an automatic retry';
          if (!turnStarted) releaseHold();
          if (this.hasValidSubmission(executionId)) return this.fail(executionId, nodeId, seq, 'Runtime closed after submit; output retained and original input cannot replay');
          this.kernel.finishExecution(executionId, 'blocked');
          this.kernel.blockNode(this.graphId, nodeId, reason);
          this.queue.complete(seq, { kind: 'blocked', reason });
          return 'blocked';
        }
        if (metering && turnStarted) {
          this.kernel.finishExecution(executionId, 'blocked');
          this.kernel.blockNode(this.graphId, nodeId, 'Interrupted turn usage is unknown; reconcile the held reservation before resuming');
          this.queue.complete(seq, { kind: 'blocked', reason: 'usage unknown after interruption' });
          return 'blocked';
        }
        // A landed submit is irreversible. Do not re-run its original work after a crash.
        if (this.hasValidSubmission(executionId)) {
          releaseHold();
          return this.fail(executionId, nodeId, seq, `Execution failed after submit: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (retriesUsed >= budget.retriesAllowed) {
          releaseHold();
          return this.fail(executionId, nodeId, seq, error instanceof Error ? error.message : String(error));
        }
        releaseHold();
        retriesUsed += 1;
        this.kernel.noteExecutionContinuation(executionId, 'retry');
        injection = undefined;
        continue;
      }
      // §9: charge what the turn actually cost. The reservation bounds the turn; this
      // settles it, so a node that under-runs keeps its remainder. An unreported figure is
      // left alone rather than assumed to be zero.
      if (metering && !report?.usage?.accounted && report?.usage && Number.isSafeInteger(report.usage.total) && report.usage.total > 0) {
        this.kernel.commitNodeUsage(this.graphId, nodeId, this.kernel.budgetState(this.graphId, nodeId, metering.limit).used + report.usage.total);
      }
      // A metered turn that reported NO usage can be neither charged nor released: releasing
      // would hand back a hold for tokens that may already have been spent, and a node could
      // then run past its budget by never reporting. The hold stays and the node parks.
      if (metering && !report?.usage) {
        this.kernel.finishExecution(executionId, 'blocked');
        this.kernel.blockNode(this.graphId, nodeId, 'turn reported no usage; its reservation is held until reconciled');
        this.queue.complete(seq, { kind: 'blocked', reason: 'usage unknown' });
        return 'blocked';
      }

      releaseHold();

      if (report?.error) {
        if (this.hasValidSubmission(executionId) || /budget|permission|paused|credential unavailable/i.test(report.error) || retriesUsed >= budget.retriesAllowed) {
          return this.fail(executionId, nodeId, seq, report.error);
        }
        retriesUsed += 1;
        this.kernel.noteExecutionContinuation(executionId, 'retry');
        injection = undefined;
        continue;
      }

      // A submit that landed in the kernel is the success signal, whatever the
      // turn reported: the node writes its outputs through the submission surface.
      if (this.hasValidSubmission(executionId) || report?.done) {
        // A node's deliverable is a promise about a file, and the promise is settled with
        // the submission: a file that was never written, or that is empty, must fail the
        // node here rather than let it pass with the work missing.
        const settled = item.kind === 'chat' ? { ok: true as const } : await this.settleDeliverable(executionId, nodeId);
        if (!settled.ok) { releaseHold(); return this.fail(executionId, nodeId, seq, settled.reason); }
        this.kernel.finishExecution(executionId, 'completed');
        this.kernel.completeNode(this.graphId, nodeId);
        this.queue.complete(seq, { kind: 'submitted' });
        releaseHold();
        return 'done';
      }

      // A reported missing-required gap is a RESUBMIT: inject it and re-turn the
      // SAME execution, because the node's own work up to now is still valid.
      if (report && report.missing && report.missing.length > 0) {
        if (resubmitsUsed < budget.resubmitsAllowed) {
          resubmitsUsed += 1;
          this.kernel.noteExecutionContinuation(executionId, 'resubmit', report.missing);
          this.kernel.noteNodeResubmit(this.graphId, nodeId, Number.MAX_SAFE_INTEGER);
          this.kernel.db.prepare('UPDATE kernel_executions SET missing_required=1 WHERE id=?').run(executionId);
          injection = { missing: report.missing };
          continue;
        }
        // The gap was never filled and there is no resubmit left.
        releaseHold();
        return this.fail(executionId, nodeId, seq, `required output(s) still missing: ${report.missing.join(', ')}`);
      }

      // No submission and no gap: a RETRY, up to the retry budget.
      if (retriesUsed >= budget.retriesAllowed) {
        releaseHold();
        return this.fail(executionId, nodeId, seq, `no valid submission after ${attempt} attempt(s)`);
      }
      retriesUsed += 1;
      this.kernel.noteExecutionContinuation(executionId, 'retry');
      injection = undefined;
    }
  }

  /**
   * Settle the node's deliverable promise, if it made one.
   *
   * A node that declared no deliverable, or a runtime with no artifact store or workspace
   * wired yet, settles as a promise kept: the absence of the machinery must not fail work
   * that made no promise. Once a promise IS declared, the file has to be there.
   */
  private async settleDeliverable(executionId: string, nodeId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const workspace = this.options.workspace?.();
    const artifacts = this.options.artifacts?.();
    if (!workspace || !artifacts) return { ok: true };
    const execution = this.kernel.execution(executionId);
    if (!execution) return { ok: true };
    return settleDeliverable({
      kernel: this.kernel,
      artifacts,
      graphId: this.graphId,
      nodeId,
      revisionVersion: execution.revisionVersion,
      executionId,
      workspace,
    });
  }

  private fail(executionId: string, nodeId: string, seq: number, reason: string): NodeOutcome {
    this.kernel.finishExecution(executionId, 'failed');
    // The reason is kept in three places on purpose: the node's status for the graph view,
    // an event for the timeline, and the queue row so it survives a restart. Dropping it in
    // memory is what made an earlier failure take several probes to find.
    this.kernel.noteQueueFailure(this.graphId, seq, reason);
    this.kernel.failNode(this.graphId, nodeId, reason);
    this.queue.complete(seq, { kind: 'failed', reason });
    return 'failed';
  }
}
