import type { KernelStore, SubmitOutput, SubmitReceipt } from './kernel-store.ts';
import { RuntimeError } from './types.ts';

/**
 * The node's submit surface, bound to one execution (Issue #1 §5, §6; backlog HB-257).
 *
 * A node's `submit_result` call has to land in the kernel as a real Submission plus its
 * Deliveries, and a refusal has to reach the model as the field-level correction §5 asks
 * for — without burning the single valid submission the execution is allowed. The kernel
 * remains the only authority on validity: this bridge never re-implements the checks, it
 * translates the kernel's refusal into the `code`/`path`/`expected`/`got` shape the tool
 * contract needs and reports the missing-required case, which the executor consumes as its
 * resubmit signal.
 *
 * The receipt passes through unchanged on success, so a caller sees `replayed` and
 * `noRecipients` exactly as §6 defines them.
 */

/** The §5 error shape a model is expected to correct against. */
export interface SubmitDefect {
  code: string;
  /** Which interface field the defect is about, or the execution when it is not a field. */
  path: string;
  expected: string;
  got: string;
}

export interface BridgeReceipt {
  accepted: boolean;
  /** Present only when accepted. */
  submissionId: string | null;
  replayed: boolean;
  noRecipients: boolean;
  deliveries: SubmitReceipt['deliveries'];
  /** Non-empty when refused; each entry is a field-level correction. */
  defects: SubmitDefect[];
  /** The required outputs that were not enabled; the executor turns this into a resubmit. */
  missingRequired: string[];
}

type SubmitOutputSet = Record<string, SubmitOutput>;

/** Turn the kernel's refusal text into the structured defect §5 promises. */
function classify(error: RuntimeError): { defects: SubmitDefect[]; missingRequired: string[] } {
  const message = error.message;

  const missing = /^Required output\(s\) not enabled: (.+)$/.exec(message);
  if (missing) {
    return {
      defects: [{ code: 'missing_required_output', path: missing[1]!.split(',').map(s => s.trim()).join(', '), expected: 'enable:true', got: 'enable:false or absent' }],
      missingRequired: missing[1]!.split(',').map(s => s.trim()),
    };
  }

  // "Output out does not satisfy ping: <field> expected number; got string"
  const badOutput = /^Output (\S+) does not satisfy (\S+): (.+)$/.exec(message);
  if (badOutput) {
    return {
      defects: [{ code: 'output_protocol_mismatch', path: badOutput[1]!, expected: `${badOutput[2]}: ${badOutput[3]}`, got: 'the value you sent' }],
      missingRequired: [],
    };
  }

  const noOutput = /^Node \S+ has no output (\S+)$/.exec(message);
  if (noOutput) {
    return {
      defects: [{ code: 'unknown_output', path: noOutput[1]!, expected: 'a declared output of this node', got: noOutput[1]! }],
      missingRequired: [],
    };
  }

  // "Delivery e to b.in does not satisfy ping: ..." — a bad target refuses the whole broadcast.
  const badTarget = /^Delivery (\S+) to (\S+) does not satisfy (\S+): (.+)$/.exec(message);
  if (badTarget) {
    return {
      defects: [{ code: 'target_protocol_mismatch', path: badTarget[2]!, expected: `${badTarget[3]}: ${badTarget[4]}`, got: 'the value the edge would carry' }],
      missingRequired: [],
    };
  }

  const already = /^Execution (\S+) already submitted/.exec(message);
  if (already) {
    return {
      defects: [{ code: 'already_submitted', path: already[1]!, expected: 'one valid submission per execution', got: 'a second, different submission' }],
      missingRequired: [],
    };
  }

  const notRunning = /^Execution (\S+) is (\S+)/.exec(message);
  if (notRunning) {
    return {
      defects: [{ code: 'execution_not_running', path: notRunning[1]!, expected: 'a running execution', got: notRunning[2]! }],
      missingRequired: [],
    };
  }

  // Anything unrecognised is still reported rather than swallowed.
  return { defects: [{ code: error.code, path: '(submission)', expected: 'a valid submission', got: message }], missingRequired: [] };
}

export class NodeSubmitBridge {
  readonly executionId: string;
  readonly nodeId: string;

  constructor(private readonly kernel: KernelStore, executionId: string) {
    this.executionId = executionId;
    const execution = kernel.execution(executionId);
    if (!execution) throw new RuntimeError('invalid_submit', `Unknown execution ${executionId}`);
    this.nodeId = execution.nodeId;
  }

  /** Submit one output set for this execution, or get the field-level correction. */
  submit(request: { outputs: Record<string, { enable?: boolean; value?: unknown }>; submissionId: string }): BridgeReceipt {
    try {
      const receipt = this.kernel.submit(this.executionId, {
        outputs: request.outputs as SubmitOutputSet,
        submissionId: request.submissionId,
      });
      // A successful submit clears any earlier missing-required mark on this execution.
      this.kernel.db.prepare('UPDATE kernel_executions SET missing_required=0 WHERE id=?').run(this.executionId);
      return {
        accepted: true,
        submissionId: receipt.submissionId,
        replayed: receipt.replayed,
        noRecipients: receipt.noRecipients,
        deliveries: receipt.deliveries,
        defects: [],
        missingRequired: [],
      };
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      const { defects, missingRequired } = classify(error);
      // Record the gap on the execution, so it survives a process restart and is the
      // durable record the driver reads back rather than a transient return value (§7).
      if (missingRequired.length > 0) {
        this.kernel.db.prepare('UPDATE kernel_executions SET missing_required=1 WHERE id=?').run(this.executionId);
      }
      return {
        accepted: false,
        submissionId: null,
        replayed: false,
        noRecipients: false,
        deliveries: [],
        defects,
        missingRequired,
      };
    }
  }

  /**
   * The message a node sees on a refusal: short, field-level, and explicit that the
   * work already done stands (§5, §7 — do not redo the implementation for a bad field).
   */
  refusalMessage(receipt: BridgeReceipt): string {
    if (receipt.accepted) throw new RuntimeError('invalid_submit', 'There is no refusal to describe');
    return [
      'submit refused: the kernel cannot accept this submission yet.',
      ...receipt.defects.map(d => `- ${d.path} (${d.code}): expected ${d.expected}; got ${d.got}`),
      'Correct these fields and submit again with the same work. Do not redo or rewrite the implementation; whatever you already wrote stays in place.',
    ].join('\n');
  }
}
