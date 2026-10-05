import { appendNodeEntry } from './node-run.ts';
import type { KernelStore, QueueRow } from './kernel-store.ts';

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
  /** `usage` is what the turn cost (§9); absent means the transport reported nothing. */
  turn(text: string): Promise<{ turnId: string; inspect: unknown; usage?: { total: number; accounted?: boolean } | undefined }>;
}

/** What one turn produced, as the driver reports it back to the executor. */
export interface DriverReport {
  error?: string;
  /** True only when the kernel holds a submission for this execution. */
  done: boolean;
  /** The required outputs still missing, when the node reported them. */
  missing?: string[];
  /**
   * What this turn cost (§9). Absent when the transport reported nothing; the budget must
   * treat that as unknown rather than free.
   */
  usage?: { total: number; accounted?: boolean } | undefined;
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
  private promptFor(executionId: string, attempt: number, injection: { missing: string[] } | undefined, input?: QueueRow): string {
    if (injection && injection.missing.length > 0) {
      return [
        `Your previous submission was refused: the required output(s) ${injection.missing.join(', ')} were not enabled.`,
        'Enable those outputs with the correct values and submit again.',
        'Do not redo or rewrite the implementation; whatever you already wrote stays in place.',
        ...(this.options.turnText ? ['', this.options.turnText(injection)] : []),
      ].join('\n');
    }
    if (attempt === 1) {
      const execution = this.options.kernel.execution(executionId)!;
      const definition = this.options.kernel.revision(execution.taskId, execution.revisionVersion)!.definition;
      const node = definition.nodes[this.options.nodeId];
      const prior = this.options.kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND node_id=? AND id<>?').get(execution.taskId, execution.nodeId, executionId) as { n: number };
      const previous = this.options.kernel.db.prepare('SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? AND id<>? ORDER BY rowid DESC LIMIT 1').get(execution.taskId, execution.nodeId, executionId) as { revision_version: number } | undefined;
      const updated = previous && previous.revision_version !== execution.revisionVersion ? `CURRENT NODE CONFIGURATION: ${JSON.stringify(node)}` : '';
      const context = this.options.initialContext?.() ?? (prior.n === 0 && node ? [
        `GRAPH OVERVIEW: ${definition.name}`,
        JSON.stringify({ nodes: Object.keys(definition.nodes), modules: Object.keys(definition.modules), edges: definition.edges }),
        `TASK: ${node.task}`,
        `ACCEPTANCE: ${JSON.stringify(node.acceptance ?? [])}`,
        `INPUT INTERFACES: ${JSON.stringify(node.inputs)}`,
        `OUTPUT INTERFACES: ${JSON.stringify(node.outputs)}`,
        `PROTOCOLS: ${JSON.stringify(definition.protocols)}`,
        `SUBMIT: ${JSON.stringify(node.submission)}. At most one valid submit per execution. Chat may reply without submit.`,
      ].join('\n') : '');
      return [context, updated, input ? `NEW ${input.kind.toUpperCase()}: ${JSON.stringify(input.payload)}` : this.options.turnText?.(undefined) ?? ''].filter(Boolean).join('\n\n');
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
  async run(executionId: string, attempt: number, injection: { missing: string[] } | undefined, input?: QueueRow): Promise<DriverReport> {
    // A crash rebuild keeps the same execution: rebuild before the turn, not instead of it.
    if (!this.options.host.alive()) await this.options.host.start();

    const prompt = this.promptFor(executionId, attempt, injection, input);
    appendNodeEntry(this.options.kernel.store, { taskId: this.options.graphId, nodeId: this.options.nodeId,
      operationId: executionId, role: 'user', kind: 'message', text: prompt });
    const turn = await this.options.host.turn(prompt);
    // Kept for every exit below: a turn that costs something must be charged even when it
    // fails or is resubmitted, or the budget under-counts exactly the turns that misbehave.
    const usage = turn.usage ? { total: turn.usage.total, ...(turn.usage.accounted ? { accounted: true } : {}) } : undefined;

    const messages = (turn.inspect as { messages?: unknown[] } | undefined)?.messages ?? [];
    const assistant = [...messages].reverse().find(message => message && typeof message === 'object' && (message as { role?: string }).role === 'assistant') as { stopReason?: string; errorMessage?: string } | undefined;
    if (assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted') return { done: false, usage, error: assistant.errorMessage ?? `Model turn ${assistant.stopReason}` };

    // The node's submit runs against the kernel; a refusal is reported, not swallowed.
    const gap = this.options.submit(executionId);

    // The kernel decides: a real submission means done, whatever the process said.
    if (this.submissionExists(executionId)) return { done: true, usage };

    if (gap && gap.missing && gap.missing.length > 0) return { done: false, missing: gap.missing, usage };

    // The execution's own missing-required mark is the durable record of a refusal: it
    // survives a process restart, so a crash mid-submit still resumes as a resubmit.
    const row = this.options.kernel.db.prepare('SELECT missing_required FROM kernel_executions WHERE id=?').get(executionId) as { missing_required: number } | undefined;
    if (row?.missing_required === 1) {
      const names = this.options.missingRequiredNames?.(executionId) ?? this.options.kernel.execution(executionId)!.pendingGap;
      if (names.length > 0) return { done: false, missing: names, usage };
      return { done: false, usage };
    }
    if (input?.kind === 'chat') return { done: true, usage };
    const execution = this.options.kernel.execution(executionId)!;
    const submission = this.options.kernel.revision(execution.taskId, execution.revisionVersion)!.definition.nodes[execution.nodeId]?.submission;
    const required = [...(submission?.required ?? []), ...(submission?.requiredAnyOf ?? [])];
    return input && required.length ? { done: false, missing: required, usage } : { done: !!input, usage };
  }
}
