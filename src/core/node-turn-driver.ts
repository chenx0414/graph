import type { KernelStore } from './kernel-store.ts';

/**
 * The turn driver `NodeExecutor` plugs into (Issue #1 §7; backlog HB-257).
 *
 * `NodeExecutor` already knows WHAT to do with a turn's outcome — retry, resubmit, or
 * move on — but it takes that outcome from a `TurnRunner`. This is the production
 * runner: it starts a dead worker, builds the right prompt for this attempt, drives one
 * turn, and then reads the KERNEL back to decide what actually happened. The kernel is
 * the authority: a turn counts as done only when a submission for this execution really
 * exists, never because the process said something reassuring.
 *
 * Prompts follow §7. The first turn of an execution carries the whole briefing; later
 * turns are continuations that do not repeat it. A resubmit names the required output
 * that is still missing and says the work already done stands, so the node corrects a
 * field instead of redoing the implementation.
 */

/**
 * The part of `ResidentHost` a turn needs. Deliberately the same shape `ExecutorHost`
 * requires, so one host value satisfies both and the executor can hand it straight to a
 * driver.
 */
export interface DriverHost {
  start(): Promise<{ processId: number }>;
  alive(): boolean;
  turn(text: string): Promise<{ turnId: string; inspect: unknown }>;
}

/** What one turn produced, as the driver reports it back to the executor. */
export interface DriverReport {
  /** True only when the kernel holds a submission for this execution. */
  done: boolean;
  /** The required outputs still missing, when the node reported them. */
  missing?: string[];
}

export interface NodeTurnDriverOptions {
  kernel: KernelStore;
  graphId: string;
  nodeId: string;
  host: DriverHost;
  /** Runs the node's submit for this execution; returns any missing-required gap. */
  submit: (executionId: string) => { missing: string[] } | void;
  /** The full first-turn briefing (§7); omitted in tests that do not need it. */
  initialContext?: () => string;
  /** Work arriving with this turn — a delivery or a chat line (§7 first vs. follow-up). */
  turnText?: (injection: { missing: string[] } | undefined) => string;
  /** The durable gap names for an execution that was refused; used after a restart. */
  missingRequiredNames?: (executionId: string) => string[];
}

export class NodeTurnDriver {
  private readonly options: NodeTurnDriverOptions;

  constructor(options: NodeTurnDriverOptions) {
    this.options = options;
  }

  private submissionExists(executionId: string): boolean {
    const row = this.options.kernel.db.prepare('SELECT 1 FROM kernel_submissions WHERE execution_id=? LIMIT 1').get(executionId);
    return row !== undefined;
  }

  /** The prompt for this attempt: an injected gap, a continuation, or the full briefing. */
  private promptFor(attempt: number, injection: { missing: string[] } | undefined): string {
    if (injection && injection.missing.length > 0) {
      return [
        `Your previous submission was refused: the required output(s) ${injection.missing.join(', ')} were not enabled.`,
        'Enable those outputs with the correct values and submit again.',
        'Do not redo or rewrite the implementation; whatever you already wrote stays in place.',
        ...(this.options.turnText ? ['', this.options.turnText(injection)] : []),
      ].join('\n');
    }
    if (attempt === 1) {
      return this.options.initialContext ? this.options.initialContext() : (this.options.turnText?.(undefined) ?? '');
    }
    // A later attempt is a continuation: it must not repeat the whole briefing (§7).
    return [
      'Your previous turn did not produce a valid submission. Continue the same work and submit this time.',
      ...(this.options.turnText ? ['', this.options.turnText(undefined)] : []),
    ].join('\n');
  }

  /**
   * Drive one turn for this execution. Called by `NodeExecutor.runOne`, which owns the
   * attempt, retry and resubmit budgets.
   */
  async run(executionId: string, attempt: number, injection: { missing: string[] } | undefined): Promise<DriverReport> {
    // A crash rebuild keeps the same execution: rebuild before the turn, not instead of it.
    if (!this.options.host.alive()) await this.options.host.start();

    await this.options.host.turn(this.promptFor(attempt, injection));

    // The node's submit runs against the kernel; a refusal is reported, not swallowed.
    const gap = this.options.submit(executionId);

    // The kernel decides: a real submission means done, whatever the process said.
    if (this.submissionExists(executionId)) return { done: true };

    if (gap && gap.missing && gap.missing.length > 0) return { done: false, missing: gap.missing };

    // The execution's own missing-required mark is the durable record of a refusal: it
    // survives a process restart, so a crash mid-submit still resumes as a resubmit.
    const row = this.options.kernel.db.prepare('SELECT missing_required FROM kernel_executions WHERE id=?').get(executionId) as { missing_required: number } | undefined;
    if (row?.missing_required === 1) {
      const names = this.options.missingRequiredNames?.(executionId) ?? [];
      if (names.length > 0) return { done: false, missing: names };
      return { done: false };
    }
    return { done: false };
  }
}
