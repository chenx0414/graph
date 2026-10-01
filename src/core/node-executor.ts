import type { KernelStore } from './kernel-store.ts';
import { NodeQueue } from './node-queue.ts';
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
  turn(text: string): Promise<{ turnId: string; inspect: unknown }>;
}

/** What a turn reported back: a missing-required gap, or nothing when it submitted. */
export interface TurnReport {
  missing?: string[];
}

/** Runs one attempt of a node's execution and reports any missing-required gap. */
export type TurnRunner = (
  executionId: string,
  attempt: number,
  injection: { missing: string[] } | undefined,
) => Promise<TurnReport | void>;

export interface NodeExecutorOptions {
  kernel: KernelStore;
  graphId: string;
  host: ExecutorHost;
  workerEntry: string;
  config: unknown;
  cwd: string;
  configPath: string;
}

export type NodeOutcome = 'done' | 'failed' | 'idle';

export class NodeExecutor {
  private readonly queue: NodeQueue;
  private readonly kernel: KernelStore;
  private readonly graphId: string;

  constructor(private readonly options: NodeExecutorOptions) {
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
    for (;;) {
      const item = this.queue.claim(nodeId);
      if (!item) return last;
      last = await this.runOne(nodeId, item.seq, run);
      if (last === 'failed') return 'failed';
    }
  }

  /** One queued item: one execution, turned until submit, failure, or budget spent. */
  private async runOne(nodeId: string, seq: number, run: TurnRunner): Promise<NodeOutcome> {
    const revision = this.kernel.latestRevision(this.graphId);
    if (!revision) throw new RuntimeError('invalid_graph', `Graph ${this.graphId} has no revision`);

    const executionId = `exec-${this.graphId}-${nodeId}-${seq}`;
    this.kernel.startExecution(this.graphId, { executionId, nodeId, revisionVersion: revision.version });

    const budget = this.queue.retryBudget(nodeId);
    let attempt = 0;
    let injection: { missing: string[] } | undefined;

    for (;;) {
      attempt += 1;
      this.queue.noteAttempt(nodeId);
      // A crash rebuild keeps the same execution; the turn resumes against the
      // rebuilt process rather than starting a fresh one.
      if (!this.options.host.alive()) await this.options.host.start();

      const report = await run(executionId, attempt, injection);

      // A submit that landed in the kernel is the success signal, whatever the
      // turn reported: the node writes its outputs through the submission surface.
      if (this.hasValidSubmission(executionId)) {
        this.kernel.finishExecution(executionId, 'completed');
        this.queue.complete(seq, { kind: 'submitted' });
        return 'done';
      }

      // A reported missing-required gap is a RESUBMIT: inject it and re-turn the
      // SAME execution, because the node's own work up to now is still valid.
      if (report && report.missing && report.missing.length > 0) {
        const used = this.kernel.nodeState(this.graphId, nodeId).resubmitsUsed;
        if (used < budget.resubmitsAllowed) {
          this.kernel.noteNodeResubmit(this.graphId, nodeId, budget.resubmitsAllowed);
          this.kernel.db.prepare('UPDATE kernel_executions SET missing_required=1 WHERE id=?').run(executionId);
          injection = { missing: report.missing };
          continue;
        }
        // The gap was never filled and there is no resubmit left.
        return this.fail(executionId, nodeId, seq, `required output(s) still missing: ${report.missing.join(', ')}`);
      }

      // No submission and no gap: a RETRY, up to the retry budget.
      if (attempt - 1 >= budget.retriesAllowed) {
        return this.fail(executionId, nodeId, seq, `no valid submission after ${attempt} attempt(s)`);
      }
    }
  }

  private fail(executionId: string, nodeId: string, seq: number, reason: string): NodeOutcome {
    this.kernel.finishExecution(executionId, 'failed');
    this.queue.complete(seq, { kind: 'failed', reason });
    return 'failed';
  }
}
