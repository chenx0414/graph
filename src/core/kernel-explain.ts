import { contentColumn } from './kernel-content.ts';
import type { KernelStore } from './kernel-store.ts';
import { RuntimeError, type Json } from './types.ts';

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
  valueTruncated: boolean; valueBytes: number; valuePreview: string | null;
  source: string | null;
  updatedAt: number | null;
}

export interface TransitionExplanation {
  cursor: number; payloadTruncated: boolean; payloadBytes: number; payloadPreview: string | null;
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
  stateTruncated: boolean; stateBytes: number; statePreview: string | null;
  latestTransition: number | null; nextAfter: number | null;
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
  latestTruncated: boolean;
  nextBefore: number | null;
  deliveries: {
    seq: number; valueTruncated: boolean; valueBytes: number; valuePreview: string | null;
    id: string; value: Json; protocol: string; revisionVersion: number; createdAt: number;
    source: string; sourceExecutionId: string | null;
    artifacts: { taskId: string; artifactId: string; version: number; digest: string | null }[];
    receiver: { kind: 'node' | 'module' | 'unknown'; state: string; operationId: string | null; reason: string | null };
  }[];
}

/** Explicit version references are navigable; arbitrary text and unversioned names are not. */
function artifactReferences(taskId: string, value: Json) {
  const found = new Map<string, { taskId: string; artifactId: string; version: number; digest: string | null }>();
  const pending: Json[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { for (const child of item) pending.push(child); continue; }
    if (typeof item.artifactId === 'string' && item.artifactId.length > 0
      && typeof item.version === 'number' && Number.isSafeInteger(item.version) && item.version > 0) {
      const reference = { taskId, artifactId: item.artifactId, version: item.version,
        digest: typeof item.digest === 'string' ? item.digest : null };
      found.set(`${reference.artifactId}:${reference.version}`, reference);
    }
    for (const child of Object.values(item)) pending.push(child);
  }
  return [...found.values()];
}

export interface ModuleHistoryQuery { after?: number; limit?: number; transitionId?: string; fullValues?: boolean; includeTransitions?: boolean }

/** Bound large JSON in SQLite, before parsing or transporting it. Columns are internal constants. */
const compactJsonColumn = (column: string, full: boolean) =>
  `CASE WHEN ${full ? '1' : '0'} OR ${contentColumn(column, 'bytes')}<=4096 THEN ${contentColumn(column)} ELSE NULL END`;

/** Current module state and a chronological page of its durable judgments (§10). */
export function explainModule(kernel: KernelStore, taskId: string, moduleId: string, query: ModuleHistoryQuery = {}): ModuleExplanation {
  const after = query.after ?? 0; const limit = query.limit ?? 20;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RuntimeError('invalid_query', 'Module history requires a non-negative after cursor and a limit from 1 to 200');
  }
  const full = query.fullValues === true;
  const moduleRow = kernel.db.prepare(`SELECT module_type,trigger,rule_version,triggered,
    ${compactJsonColumn('state', full)} AS content,${contentColumn('state', 'bytes')} AS bytes,
    CASE WHEN NOT ${full ? '1' : '0'} AND ${contentColumn('state', 'bytes')}>4096 THEN ${contentColumn('state', 'preview')} ELSE NULL END AS preview
    FROM kernel_modules WHERE task_id=? AND module_id=?`).get(taskId, moduleId) as
    { module_type: string; trigger: string; content: string | null; bytes: number; preview: string | null; rule_version: number; triggered: number } | undefined;
  if (!moduleRow) throw new RuntimeError('invalid_module', `Unknown module ${taskId}/${moduleId}`);
  const declared = kernel.latestRevision(taskId)?.definition.modules[moduleId]?.inputs ?? {};
  const inputs: InputExplanation[] = Object.entries(declared).map(([name, spec]) => {
    const row = kernel.db.prepare(`SELECT delivered,source,updated_at,${compactJsonColumn('value', full)} AS content,
      ${contentColumn('value', 'bytes')} AS bytes,
      CASE WHEN NOT ${full ? '1' : '0'} AND ${contentColumn('value', 'bytes')}>4096 THEN ${contentColumn('value', 'preview')} ELSE NULL END AS preview
      FROM kernel_module_inputs WHERE task_id=? AND module_id=? AND name=?`).get(taskId, moduleId, name) as
      { delivered: number; source: string | null; updated_at: number; content: string | null; bytes: number | null; preview: string | null } | undefined;
    return { name, protocol: spec.protocol, delivered: row?.delivered === 1, missing: row?.delivered !== 1,
      value: row?.delivered && row.content !== null ? JSON.parse(row.content) as Json : null,
      valueTruncated: row?.delivered === 1 && row.content === null && (row.bytes ?? 0) > 4096,
      valueBytes: row?.bytes ?? 0, valuePreview: row?.preview ?? null,
      source: row?.source ?? null, updatedAt: row?.updated_at ?? null };
  });
  const payloadFields = ['input_value', 'state_before', 'state_after', 'outputs'];
  const rows = query.includeTransitions === false ? [] : kernel.db.prepare(`SELECT rowid AS cursor,id,input_name,verdict,rule_version,reason,created_at,
    ${payloadFields.map(column => `${compactJsonColumn(column, Boolean(query.transitionId))} AS ${column}`).join(',')},
    ${payloadFields.map(column => contentColumn(column, 'bytes')).join('+')} AS bytes,
    ${contentColumn('input_value', 'preview')} AS preview
    FROM kernel_module_transitions WHERE task_id=? AND module_id=? AND rowid>? AND (? IS NULL OR id=?) ORDER BY rowid LIMIT ?`)
    .all(taskId, moduleId, after, query.transitionId ?? null, query.transitionId ?? null, limit + 1) as {
      cursor: number; id: string; input_name: string; input_value: string | null; state_before: string | null; state_after: string | null;
      verdict: string | null; outputs: string | null; rule_version: number; reason: string; created_at: number; bytes: number; preview: string;
    }[];
  if (query.transitionId && !rows.length) throw new RuntimeError('invalid_transition', 'Transition does not belong to this graph module');
  const transitions: TransitionExplanation[] = rows.slice(0, limit).map(row => {
    const truncated = payloadFields.some(column => row[column as 'input_value' | 'state_before' | 'state_after' | 'outputs'] === null);
    return { cursor: row.cursor, id: row.id, inputName: row.input_name,
      inputValue: row.input_value === null ? null : JSON.parse(row.input_value) as Json,
      stateBefore: row.state_before === null ? null : JSON.parse(row.state_before) as Json,
      stateAfter: row.state_after === null ? null : JSON.parse(row.state_after) as Json,
      verdict: row.verdict, outputs: row.outputs === null ? {} : JSON.parse(row.outputs) as Record<string, Json>,
      ruleVersion: row.rule_version, reason: row.reason, createdAt: row.created_at,
      payloadTruncated: truncated, payloadBytes: row.bytes, payloadPreview: truncated ? row.preview : null };
  });
  const latest = kernel.db.prepare('SELECT MAX(rowid) AS cursor FROM kernel_module_transitions WHERE task_id=? AND module_id=?')
    .get(taskId, moduleId) as { cursor: number | null };
  return { moduleId, type: moduleRow.module_type, trigger: moduleRow.trigger, triggered: moduleRow.triggered === 1,
    state: moduleRow.content === null ? null : JSON.parse(moduleRow.content) as Json,
    stateTruncated: moduleRow.content === null, stateBytes: moduleRow.bytes, statePreview: moduleRow.preview,
    ruleVersion: moduleRow.rule_version, latestTransition: latest.cursor,
    nextAfter: rows.length > limit ? transitions.at(-1)!.cursor : null, inputs, transitions };
}

/**
 * An edge's named endpoints, its enabled state and its real delivery history (§10).
 * A never-delivered edge reports `latest: null` — the view must not fill that in with
 * an empty value, because "nothing arrived" and "an empty thing arrived" differ.
 */
export function explainEdge(kernel: KernelStore, taskId: string, edgeId: string, revisionVersion?: number, query: { before?: number; limit?: number; deliveryId?: string; fullValue?: boolean } = {}): EdgeExplanation {
  const version = revisionVersion ?? kernel.latestRevision(taskId)?.version;
  const revision = version === undefined ? null : kernel.revision(taskId, version);
  const edge = revision?.definition.edges[edgeId];
  if (!edge) throw new Error(`Unknown edge ${taskId}/${edgeId}`);

  const target = edge.to.includes('.') ? (revision!.definition.nodes[edge.to.split('.')[0]!] ?? revision!.definition.modules[edge.to.split('.')[0]!]) : undefined;
  const port = edge.to.includes('.') ? edge.to.split('.').slice(1).join('.') : '';
  const protocol = target?.inputs[port]?.protocol ?? null;

  const limit = query.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1))) {
    throw new RuntimeError('invalid_query', 'Edge history requires a positive before cursor and a limit from 1 to 200');
  }
  // Omit large bytes in SQLite itself, so the overview never reads/parses entire values.
  const rows = kernel.db.prepare(`SELECT id,submission_id AS submissionId,protocol,seq,source,
    revision_version AS revisionVersion,created_at AS createdAt,
    ${contentColumn('value', 'bytes')} AS valueBytes,
    CASE WHEN ? OR ${contentColumn('value', 'bytes')}<=4096 THEN ${contentColumn('value')} ELSE NULL END AS content,
    CASE WHEN NOT ? AND ${contentColumn('value', 'bytes')}>4096 THEN ${contentColumn('value', 'preview')} ELSE NULL END AS valuePreview
    FROM kernel_deliveries WHERE task_id=? AND edge_id=? AND (? IS NULL OR seq<?)
    AND (? IS NULL OR id=?) ORDER BY seq DESC LIMIT ?`)
    .all(query.fullValue ? 1 : 0, query.fullValue ? 1 : 0, taskId, edgeId, query.before ?? null, query.before ?? null,
      query.deliveryId ?? null, query.deliveryId ?? null, limit + 1) as {
      id: string; submissionId: string | null; protocol: string; seq: number; source: string;
      revisionVersion: number; createdAt: number; valueBytes: number; content: string | null; valuePreview: string | null;
    }[];
  if (query.deliveryId && !rows.length) throw new RuntimeError('invalid_delivery', 'Delivery does not belong to this graph edge');
  const deliveries = rows.slice(0, limit).map(row => ({ ...row, value: row.content === null ? null : JSON.parse(row.content) as Json }));

  const newest = query.before !== undefined || query.deliveryId
    ? kernel.db.prepare(`SELECT CASE WHEN ${contentColumn('value', 'bytes')}<=4096 THEN ${contentColumn('value')} ELSE NULL END AS content
        FROM kernel_deliveries WHERE task_id=? AND edge_id=? ORDER BY seq DESC LIMIT 1`).get(taskId, edgeId) as { content: string | null } | undefined
    : deliveries[0];
  return {
    edgeId,
    from: edge.from,
    to: edge.to,
    enabled: edge.enabled !== false,
    protocol,
    latest: newest?.content ? JSON.parse(newest.content) as Json : null,
    latestTruncated: newest !== undefined && newest.content === null,
    nextBefore: rows.length > limit ? deliveries.at(-1)!.seq : null,
    deliveries: deliveries.map(row => {
      const submission = row.submissionId ? kernel.db.prepare('SELECT execution_id FROM kernel_submissions WHERE task_id=? AND id=?')
        .get(taskId, row.submissionId) as { execution_id: string } | undefined : undefined;
      const queue = kernel.db.prepare(`SELECT state,reason FROM kernel_queue WHERE task_id=? AND kind='delivery' AND json_extract(${contentColumn('payload')},'$.deliveryId')=? ORDER BY seq DESC LIMIT 1`)
        .get(taskId, row.id) as { state: string; reason: string | null } | undefined;
      const inbox = kernel.db.prepare('SELECT processed FROM kernel_module_inbox WHERE task_id=? AND delivery_id=?')
        .get(taskId, row.id) as { processed: number } | undefined;
      const operation = kernel.db.prepare('SELECT id,state,error FROM kernel_module_operations WHERE task_id=? AND delivery_id=?')
        .get(taskId, row.id) as { id: string; state: string; error: string | null } | undefined;
      return {
        id: row.id, value: row.value, protocol: row.protocol, seq: row.seq,
        valueTruncated: row.content === null, valueBytes: row.valueBytes, valuePreview: row.valuePreview,
        revisionVersion: row.revisionVersion, createdAt: row.createdAt,
        source: row.source, sourceExecutionId: submission?.execution_id ?? null,
        artifacts: artifactReferences(taskId, row.value),
        // Read durable receipt state: delivery acceptance alone never proves completion.
        receiver: queue ? { kind: 'node' as const, state: queue.state, operationId: null, reason: queue.reason }
          : inbox ? { kind: 'module' as const, state: operation?.state ?? (inbox.processed ? 'processed' : 'queued'),
            operationId: operation?.id ?? null, reason: operation?.error ?? null }
          : { kind: 'unknown' as const, state: 'accepted', operationId: null, reason: null },
      };
    }),
  };
}
