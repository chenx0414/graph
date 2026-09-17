import type { TaskStore } from './store.ts';
import { RuntimeError, type Json } from './types.ts';

export interface TalentSample {
  kind: 'task' | 'chat';
  taskId: string; nodeId: string; instanceId: string;
  definitionVersion: string | null; model: string | null; request: string | null;
  status: string; unfinished: boolean; failed: boolean; waitingMs: number;
  attempts: number; reworkRounds: number;
  tokens: number | null;
  runMs: number | null;
  /** Per-currency known amounts for this instance; an instance may have used
   * several models/currencies across rework rounds. */
  costs: Record<string, number>;
  costUnknown: boolean;
  startedAt: number | null;
}

export interface MetricStat { mean: number | null; samples: number; unknown: number; unfinished: number; failed: number }
export interface CurrencyStat extends MetricStat { currency: string }
export interface TalentStats {
  token: MetricStat;
  runMs: MetricStat;
  /** One entry per currency; a mixed-currency sample set never yields one
   * meaningless mean, it yields per-currency means plus `mixedCurrency`. */
  cost: { byCurrency: CurrencyStat[]; mixedCurrency: boolean; unknown: boolean };
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
export function talentExperience(store: TaskStore, id: string, options: { version?: number; allVersions?: boolean } = {}) {
  // Default scope is the same version the detail view shows (the latest
  // published one); mixing versions into one mean is an explicit opt-in.
  const latest = (store.db.prepare('SELECT MAX(version) AS version FROM definitions WHERE id=?').get(id) as { version: number | null }).version;
  const scopeVersion = options.allVersions ? undefined : (options.version ?? latest ?? undefined);
  const like = scopeVersion === undefined ? `${id}@%` : `${id}@${scopeVersion}`;
  const rows = store.db.prepare(`SELECT i.id AS instance_id, i.definition_version, i.model, i.used,
    n.task_id, n.id AS node_id, n.status, n.spec,
    t.phase, t.created_seq, t.request
    FROM instances i JOIN nodes n ON n.instance_id=i.id JOIN tasks t ON t.id=n.task_id
    WHERE i.definition_version ${options.version === undefined ? 'LIKE ?' : '=?'}
    ORDER BY t.created_seq, n.rowid`).all(like) as {
    instance_id: string; definition_version: string | null; model: string | null; used: number;
    task_id: string; node_id: string; status: string; spec: string; phase: string; created_seq: number; request: string;
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
    const costs: Record<string, number> = {};
    let costUnknown = false;
    for (const invocation of invocations) {
      if (!invocation.cost) { costUnknown = true; continue; }
      const parsed = JSON.parse(invocation.cost) as { unknown?: boolean; amount?: number; currency?: string };
      if (parsed.unknown === true || typeof parsed.amount !== 'number' || !Number.isFinite(parsed.amount)) { costUnknown = true; continue; }
      const currency = parsed.currency && parsed.currency.trim() ? parsed.currency : '?';
      costs[currency] = (costs[currency] ?? 0) + parsed.amount;
    }
    const attempts = operations.filter(operation => operation.state === 'succeeded').length;
    return {
      kind: spec.role === 'master' ? 'chat' : 'task',
      taskId: row.task_id, nodeId: row.node_id, instanceId: row.instance_id,
      definitionVersion: row.definition_version, model: row.model, request: row.request,
      waitingMs: operations.reduce((sum, operation) => sum + operation.waiting_ms, 0),
      status: row.status, unfinished: !finished, failed: unsuccessful,
      attempts, reworkRounds: Math.max(0, attempts - 1),
      tokens, runMs, costs, costUnknown,
      startedAt: null,
    };
  });
  const task = samples.filter(sample => sample.kind === 'task');
  const chat = samples.filter(sample => sample.kind === 'chat');
  const statsFor = (list: TalentSample[]): TalentStats => {
    const currencies = [...new Set(list.flatMap(sample => Object.keys(sample.costs)))].sort();
    const finished = list.filter(sample => !sample.unfinished);
    // Each currency mean uses instances that actually have a known amount in
    // that currency; one instance can legitimately contribute to several
    // buckets after a model/currency switch without inflating the count.
    const byCurrency: CurrencyStat[] = currencies.map(currency => {
      const scoped = finished.filter(sample => typeof sample.costs[currency] === 'number');
      const values = scoped.map(sample => sample.costs[currency]!);
      return {
        currency,
        mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        samples: values.length,
        unknown: scoped.filter(sample => sample.costUnknown).length,
        unfinished: list.filter(sample => sample.unfinished && typeof sample.costs[currency] === 'number').length,
        failed: scoped.filter(sample => sample.failed).length,
      };
    });
    const unknown = finished.some(sample => sample.costUnknown);
    return {
      token: metric(list, sample => sample.tokens, sample => sample.failed),
      runMs: metric(list, sample => sample.runMs, sample => sample.failed),
      cost: { byCurrency, mixedCurrency: currencies.length > 1, unknown },
      totalSamples: list.length,
      taskSamples: list.filter(sample => sample.kind === 'task').length,
      chatSamples: list.filter(sample => sample.kind === 'chat').length,
    };
  };
  return { scope: { version: scopeVersion ?? null, allVersions: scopeVersion === undefined }, samples, task: statsFor(task), chat: statsFor(chat), all: statsFor(samples) };
}

/** Definition detail with versions, bound capabilities and their install state. */
export function talentDetail(store: TaskStore, id: string, options: { version?: number } = {}) {
  const versions = (store.db.prepare('SELECT version,spec FROM definitions WHERE id=? ORDER BY version').all(id) as { version: number; spec: string }[])
    .map(row => ({
      version: row.version,
      spec: JSON.parse(row.spec) as {
        recommendedGrade: string;
        capabilities?: { id: string; version: string }[];
        prompts?: { agent?: { id: string; version: string }; tool?: { id: string; version: string } };
        review?: boolean;
        snapshot?: Json;
      },
    }));
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
  const prompts = Object.entries(chosen.spec.prompts ?? {}).map(([role, bound]) => {
    if (!bound) return null;
    const record = store.db.prepare('SELECT kind,source,version,snapshot,status FROM capabilities WHERE id=? AND version=?').get(bound.id, bound.version) as
      { kind: string; source: string; version: string; snapshot: string; status: string } | undefined;
    return {
      id: bound.id,
      version: bound.version,
      role,
      kind: record?.kind ?? null,
      status: record?.status ?? 'missing',
      source: record?.source ?? null,
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
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
    prompts,
  };
}
