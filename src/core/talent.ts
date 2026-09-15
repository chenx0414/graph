import type { TaskStore } from './store.ts';
import { RuntimeError, type Json } from './types.ts';

export interface TalentSample {
  kind: 'task' | 'chat';
  taskId: string; nodeId: string; instanceId: string;
  definitionVersion: string | null; model: string | null;
  status: string; unfinished: boolean; failed: boolean;
  attempts: number; reworkRounds: number;
  tokens: number | null;
  runMs: number | null;
  cost: number | null;
  currency: string | null;
  costUnknown: boolean;
  startedAt: number | null;
}

export interface MetricStat { mean: number | null; samples: number; unknown: number; unfinished: number; failed: number }
export interface TalentStats {
  token: MetricStat;
  runMs: MetricStat;
  cost: MetricStat & { currency: string | null; mixedCurrency: boolean };
  totalSamples: number;
  taskSamples: number;
  chatSamples: number;
}

function metric(samples: TalentSample[], read: (sample: TalentSample) => number | null, failed: (sample: TalentSample) => boolean) {
  const finished = samples.filter(sample => !sample.unfinished);
  const values = finished.map(read).filter((value): value is number => value !== null);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    mean,
    samples: values.length,
    unknown: finished.filter(sample => read(sample) === null).length,
    unfinished: samples.filter(sample => sample.unfinished).length,
    failed: samples.filter(failed).length,
  };
}

/** Per-definition experience from the recorded ledger. One instance is one
 * experience; rework rounds on the same instance never inflate the count. */
export function talentExperience(store: TaskStore, id: string, options: { version?: number } = {}) {
  const like = options.version === undefined ? `${id}@%` : `${id}@${options.version}`;
  const rows = store.db.prepare(`SELECT i.id AS instance_id, i.definition_version, i.model, i.used,
    n.task_id, n.id AS node_id, n.status, n.spec,
    t.phase, t.created_seq
    FROM instances i JOIN nodes n ON n.instance_id=i.id JOIN tasks t ON t.id=n.task_id
    WHERE i.definition_version ${options.version === undefined ? 'LIKE ?' : '=?'}
    ORDER BY t.created_seq, n.rowid`).all(like) as {
    instance_id: string; definition_version: string | null; model: string | null; used: number;
    task_id: string; node_id: string; status: string; spec: string; phase: string; created_seq: number;
  }[];
  const samples: TalentSample[] = rows.map(row => {
    const spec = JSON.parse(row.spec) as { role?: string };
    const invocations = store.db.prepare('SELECT usage,cost FROM invocations WHERE instance_id=? ORDER BY rowid').all(row.instance_id) as { usage: string | null; cost: string | null }[];
    const operations = store.db.prepare('SELECT state,dispatched_at,settled_at,waiting_ms FROM operations WHERE instance_id=? ORDER BY rowid').all(row.instance_id) as { state: string; dispatched_at: number | null; settled_at: number | null; waiting_ms: number }[];
    const finished = ['succeeded', 'skipped', 'retired'].includes(row.status);
    const unsuccessful = ['failed', 'blocked'].includes(row.status);
    const usageKnown = invocations.length > 0 && invocations.every(invocation => invocation.usage !== null);
    const tokens = usageKnown ? invocations.reduce((sum, invocation) => sum + Object.values(JSON.parse(invocation.usage!) as Record<string, number>).reduce((inner, value) => inner + value, 0), 0) : null;
    const timings = operations.map(operation => operation.dispatched_at !== null && operation.settled_at !== null
      ? Math.max(0, operation.settled_at - operation.dispatched_at - operation.waiting_ms)
      : null);
    const runMs = operations.length && timings.every((value): value is number => value !== null) ? timings.reduce((sum, value) => sum + value, 0) : null;
    const currencies = [...new Set(invocations.map(invocation => {
      if (!invocation.cost) return undefined;
      const parsed = JSON.parse(invocation.cost) as { unknown?: boolean; currency?: string };
      return parsed.unknown ? undefined : parsed.currency;
    }).filter((value): value is string => Boolean(value)))];
    const costUnknown = invocations.some(invocation => !invocation.cost || (JSON.parse(invocation.cost) as { unknown?: boolean }).unknown === true);
    const cost = costUnknown || currencies.length > 1 ? null : invocations.reduce((sum, invocation) => {
      const parsed = JSON.parse(invocation.cost!) as { amount?: number };
      return sum + (typeof parsed.amount === 'number' ? parsed.amount : 0);
    }, 0);
    const attempts = operations.filter(operation => operation.state === 'succeeded').length;
    return {
      kind: spec.role === 'master' ? 'chat' : 'task',
      taskId: row.task_id, nodeId: row.node_id, instanceId: row.instance_id,
      definitionVersion: row.definition_version, model: row.model,
      status: row.status, unfinished: !finished, failed: unsuccessful,
      attempts, reworkRounds: Math.max(0, attempts - 1),
      tokens, runMs, cost, currency: currencies[0] ?? null, costUnknown,
      startedAt: null,
    };
  });
  const task = samples.filter(sample => sample.kind === 'task');
  const chat = samples.filter(sample => sample.kind === 'chat');
  const statsFor = (list: TalentSample[]): TalentStats => ({
    token: metric(list, sample => sample.tokens, sample => sample.failed),
    runMs: metric(list, sample => sample.runMs, sample => sample.failed),
    cost: (() => {
      const currencies = [...new Set(list.filter(sample => !sample.unfinished && sample.cost !== null).map(sample => sample.currency!))];
      const base = metric(list, sample => sample.costUnknown ? null : sample.cost, sample => sample.failed);
      return { ...base, currency: currencies.length === 1 ? currencies[0]! : null, mixedCurrency: currencies.length > 1 };
    })(),
    totalSamples: list.length,
    taskSamples: list.filter(sample => sample.kind === 'task').length,
    chatSamples: list.filter(sample => sample.kind === 'chat').length,
  });
  return { samples, task: statsFor(task), chat: statsFor(chat), all: statsFor(samples) };
}

/** Definition detail with versions, bound capabilities and their install state. */
export function talentDetail(store: TaskStore, id: string, options: { version?: number } = {}) {
  const versions = (store.db.prepare('SELECT version,spec FROM definitions WHERE id=? ORDER BY version').all(id) as { version: number; spec: string }[])
    .map(row => ({ version: row.version, spec: JSON.parse(row.spec) as { recommendedGrade: string; capabilities?: { id: string; version: string }[]; review?: boolean; snapshot?: Json } }));
  if (!versions.length) throw new RuntimeError('not_found', `Unknown Agent definition ${id}`);
  const chosen = options.version === undefined ? versions[versions.length - 1]! : versions.find(item => item.version === options.version);
  if (!chosen) throw new RuntimeError('not_found', `Definition ${id}@${options.version} is not published`);
  const capabilities = (chosen.spec.capabilities ?? []).map(bound => {
    const record = store.db.prepare('SELECT kind,source,version,snapshot,status FROM capabilities WHERE id=? AND version=?').get(bound.id, bound.version) as
      { kind: string; source: string; version: string; snapshot: string; status: string } | undefined;
    return {
      id: bound.id, version: bound.version, kind: record?.kind ?? null, status: record?.status ?? 'missing',
      source: record?.source ?? null,
    };
  });
  const preset = chosen.spec.snapshot && typeof chosen.spec.snapshot === 'object' && !Array.isArray(chosen.spec.snapshot)
    ? (chosen.spec.snapshot as { preset?: { id?: string; version?: string; hash?: string; license?: string; source?: string }; description?: string })
    : undefined;
  return {
    id, version: chosen.version, versions: versions.map(item => item.version),
    recommendedGrade: chosen.spec.recommendedGrade,
    review: Boolean(chosen.spec.review),
    description: preset?.description ?? null,
    traceability: preset?.preset ? { origin: 'preset', ...preset.preset } : { origin: 'user' },
    capabilities,
  };
}
