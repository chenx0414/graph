import type { KernelStore } from './kernel-store.ts';
import type { Json } from './types.ts';

/**
 * The explanation projections (Issue #1 §10, §14).
 *
 * §10 is explicit that a module detail must not merely say "succeeded", and that an
 * edge detail must not draw an undelivered value as empty. Both are easy to get wrong
 * by building the view from the *success* flags rather than from the records, so these
 * projections read the kernel's own rows and report what is actually known:
 *
 *   - every declared input is listed, and an input that was never delivered is
 *     `missing` with a null value — which is a different state from a delivered
 *     `false` or `null` (§2: 没有收到与收到 false/null 是不同状态);
 *   - every transition is listed with its verdict text, rule version, reason and the
 *     outputs it actually produced, so "no rule matched" and "held" are visible rather
 *     than collapsed into a pass/fail bit;
 *   - a reopen appears as its own transition with no verdict and no outputs, because
 *     it clears the latch and emits nothing;
 *   - an edge carries its history and its newest value, and says `none` when it has
 *     never delivered;
 *   - `enabled` and a business outcome are separate axes: a disabled edge is not a
 *     failed one, and neither is derived from the other.
 */

export interface InputExplanation {
  name: string;
  protocol: string;
  delivered: boolean;
  /** True exactly when nothing was ever delivered to this input. */
  missing: boolean;
  value: Json;
  source: string | null;
  updatedAt: number | null;
}

export interface TransitionExplanation {
  id: string;
  inputName: string;
  inputValue: Json;
  stateBefore: Json;
  stateAfter: Json;
  /** The verdict text, or null when this record judged nothing (e.g. a reopen). */
  verdict: string | null;
  outputs: Record<string, Json>;
  ruleVersion: number;
  reason: string;
  createdAt: number;
}

export interface ModuleExplanation {
  moduleId: string;
  type: string;
  /** `each` judges on every update; `once` latches after it fires. */
  trigger: string;
  /** Whether a `once` module has fired and is now latched. */
  triggered: boolean;
  state: Json;
  ruleVersion: number;
  inputs: InputExplanation[];
  transitions: TransitionExplanation[];
}

export interface EdgeExplanation {
  edgeId: string;
  from: string;
  to: string;
  enabled: boolean;
  protocol: string | null;
  /** The newest delivery's value, or null when the edge has never delivered. */
  latest: Json;
  deliveries: { id: string; value: Json; protocol: string; revisionVersion: number; createdAt: number }[];
}

/** Everything §10 asks a module panel to show, read from the records themselves. */
export function explainModule(kernel: KernelStore, taskId: string, moduleId: string): ModuleExplanation {
  const moduleRow = kernel.db.prepare('SELECT * FROM kernel_modules WHERE task_id=? AND module_id=?').get(taskId, moduleId) as
    { module_id: string; module_type: string; trigger: string; state: string; rule_version: number; triggered: number } | undefined;
  if (!moduleRow) throw new Error(`Unknown module ${taskId}/${moduleId}`);

  const revision = kernel.latestRevision(taskId);
  const declared = revision?.definition.modules[moduleId]?.inputs ?? {};

  // Every DECLARED input is listed, whether or not anything ever arrived: an input
  // that is simply absent would be indistinguishable from one that was forgotten.
  const inputs: InputExplanation[] = Object.entries(declared).map(([name, spec]) => {
    const row = kernel.moduleInput(taskId, moduleId, name);
    return {
      name,
      protocol: spec.protocol,
      delivered: row?.delivered ?? false,
      missing: !(row?.delivered ?? false),
      value: row?.delivered ? (row.value ?? null) : null,
      source: row?.source ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });

  const transitions: TransitionExplanation[] = kernel.moduleTransitions(taskId, moduleId).map(row => ({
    id: row.id,
    inputName: row.inputName,
    inputValue: row.inputValue,
    stateBefore: row.stateBefore,
    stateAfter: row.stateAfter,
    verdict: row.verdict,
    outputs: row.outputs,
    ruleVersion: row.ruleVersion,
    reason: row.reason,
    createdAt: row.createdAt,
  }));

  return {
    moduleId,
    type: moduleRow.module_type,
    trigger: moduleRow.trigger,
    triggered: moduleRow.triggered === 1,
    state: JSON.parse(moduleRow.state) as Json,
    ruleVersion: moduleRow.rule_version,
    inputs,
    transitions,
  };
}

/**
 * An edge's named endpoints, its enabled state and its real delivery history (§10).
 * A never-delivered edge reports `latest: null` — the view must not fill that in with
 * an empty value, because "nothing arrived" and "an empty thing arrived" differ.
 */
export function explainEdge(kernel: KernelStore, taskId: string, edgeId: string, revisionVersion?: number): EdgeExplanation {
  const version = revisionVersion ?? kernel.latestRevision(taskId)?.version;
  const revision = version === undefined ? null : kernel.revision(taskId, version);
  const edge = revision?.definition.edges[edgeId];
  if (!edge) throw new Error(`Unknown edge ${taskId}/${edgeId}`);

  const target = edge.to.includes('.') ? revision!.definition.nodes[edge.to.split('.')[0]!] : undefined;
  const port = edge.to.includes('.') ? edge.to.split('.').slice(1).join('.') : '';
  const protocol = target?.inputs[port]?.protocol ?? null;

  const deliveries = kernel.deliveriesForEdge(taskId, edgeId);

  return {
    edgeId,
    from: edge.from,
    to: edge.to,
    enabled: edge.enabled !== false,
    protocol,
    latest: deliveries.length > 0 ? deliveries[0]!.value : null,
    deliveries: deliveries.map(row => ({
      id: row.id, value: row.value, protocol: row.protocol,
      revisionVersion: row.revisionVersion, createdAt: row.createdAt,
    })),
  };
}
