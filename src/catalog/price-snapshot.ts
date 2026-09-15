/**
 * Archived default price snapshot (C01).
 *
 * Every entry carries the official page it was read from and the date it was
 * read, so the wizard can show a reference price with provenance instead of an
 * invented number. Models that could not be verified stay unknown: this module
 * never zero-fills a price. Amounts are normalized per million tokens.
 *
 * The snapshot is intentionally a plain data module: refreshing is an explicit
 * user action (`applyPriceSnapshot`), and a refresh only re-stamps/re-verifies
 * the archived entries against their source pages; it never rewrites the cost
 * already frozen on historical invocations.
 */
import type { ModelCost, ModelPricing } from './models.ts';

export interface PriceSnapshot {
  provider: string;
  modelId: string;
  cost: ModelCost;
  currency: string;
  unit: 'per_million_tokens';
  sourceUrl: string;
  /** ISO date (UTC) the source page was read. */
  retrievedAt: string;
  /** Revision frozen into every invocation cost produced from this entry. */
  catalogRevision: string;
  /** Human-readable caveat, for example peak/off-peak basis or an upper bound. */
  note?: string;
}

/** Bump when the archived amounts change; the date stays the retrieval date. */
export const PRICE_SNAPSHOT_BASE = '2026-09-15';

/**
 * Verified 2026-09-15:
 * - Anthropic: https://www.anthropic.com/pricing (standard API rates; cache
 *   read 0.1x, 5m cache write 1.25x).
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing (peak rates
 *   used as a conservative upper bound; off-peak is half. DeepSeek publishes
 *   no separate cache-write rate, so the cache-miss rate is reused as an upper
 *   bound rather than a zero).
 * OpenAI, Google Gemini and OpenRouter pages were not readable from this
 * environment (HTTP 403 / no static table), so their template models carry no
 * price and stay unknown.
 */
export const PRICE_SNAPSHOT: PriceSnapshot[] = [
  {
    provider: 'anthropic', modelId: 'claude-sonnet-4-5',
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    currency: 'USD', unit: 'per_million_tokens',
    sourceUrl: 'https://www.anthropic.com/pricing', retrievedAt: PRICE_SNAPSHOT_BASE,
    catalogRevision: `${PRICE_SNAPSHOT_BASE}.anthropic`,
  },
  {
    provider: 'anthropic', modelId: 'claude-haiku-4-5',
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    currency: 'USD', unit: 'per_million_tokens',
    sourceUrl: 'https://www.anthropic.com/pricing', retrievedAt: PRICE_SNAPSHOT_BASE,
    catalogRevision: `${PRICE_SNAPSHOT_BASE}.anthropic`,
  },
  {
    provider: 'deepseek', modelId: 'deepseek-flash',
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
    currency: 'USD', unit: 'per_million_tokens',
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', retrievedAt: PRICE_SNAPSHOT_BASE,
    catalogRevision: `${PRICE_SNAPSHOT_BASE}.deepseek.peak`,
    note: 'DeepSeek peak rate (off-peak is half); cache write conservatively priced at the miss rate.',
  },
  {
    provider: 'deepseek', modelId: 'deepseek-v4-pro',
    cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
    currency: 'USD', unit: 'per_million_tokens',
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', retrievedAt: PRICE_SNAPSHOT_BASE,
    catalogRevision: `${PRICE_SNAPSHOT_BASE}.deepseek.peak`,
    note: 'DeepSeek peak rate (off-peak is half); cache write conservatively priced at the miss rate.',
  },
];

/** Lookup by provider template and upstream model id. */
export function snapshotFor(provider: string, modelId: string): PriceSnapshot | undefined {
  return PRICE_SNAPSHOT.find(entry => entry.provider === provider && entry.modelId === modelId);
}

export function snapshotPricing(snapshot: PriceSnapshot, revision = snapshot.catalogRevision, retrievedAt = snapshot.retrievedAt): ModelPricing {
  return {
    currency: snapshot.currency,
    unit: snapshot.unit,
    sourceUrl: snapshot.sourceUrl,
    retrievedAt,
    catalogRevision: revision,
    status: 'known',
  };
}

export type PriceRefreshStatus = 'known' | 'stale' | 'unknown' | 'manual';

export interface PriceRefreshResult {
  modelId: string;
  provider: string;
  status: PriceRefreshStatus;
  sourceUrl?: string;
  reason?: string;
}

export interface PriceRefreshOptions {
  /** Re-verification of one archived entry against its official page. */
  verify: (snapshot: PriceSnapshot) => boolean;
  /** Revision stamped on entries verified in this refresh. */
  revision: string;
  /** ISO date of this refresh. */
  retrievedAt: string;
}

interface ConfigDocument {
  models?: { entries?: Record<string, unknown>[] };
}

/**
 * Apply the archived snapshot to one raw config document.
 *
 * Rules (C01):
 * - verified entry: frozen amounts + new revision/date;
 * - unverifiable entry with a previous price: amounts kept, status 'stale';
 * - no archived entry: untouched, status 'unknown' (never zero-filled);
 * - manual override without a snapshot entry: kept as-is, status 'manual'.
 * Historical invocation cost JSON is stored elsewhere and never touched here.
 */
export function applyPriceSnapshot(document: unknown, options: PriceRefreshOptions): { document: unknown; results: PriceRefreshResult[] } {
  const results: PriceRefreshResult[] = [];
  if (!document || typeof document !== 'object') return { document, results };
  const copy = structuredClone(document) as ConfigDocument;
  const entries = copy.models?.entries;
  if (!Array.isArray(entries)) return { document: copy, results };
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const provider = typeof entry.provider === 'string' ? entry.provider : '';
    const upstream = typeof entry.modelId === 'string' ? entry.modelId : typeof entry.id === 'string' ? entry.id : '';
    const previous = entry.pricing as { status?: string; sourceUrl?: string } | undefined;
    const snapshot = snapshotFor(provider, upstream);
    if (!snapshot) {
      if (previous?.status === 'known' && previous.sourceUrl === 'manual') {
        results.push({ modelId: upstream, provider, status: 'manual', reason: 'manual override kept' });
      } else {
        results.push({ modelId: upstream, provider, status: 'unknown', reason: 'no archived price for this model' });
      }
      continue;
    }
    let verified = false;
    try {
      verified = options.verify(snapshot);
    } catch {
      verified = false;
    }
    if (verified) {
      entry.cost = { ...snapshot.cost };
      entry.pricing = snapshotPricing(snapshot, options.revision, options.retrievedAt);
      results.push({ modelId: upstream, provider, status: 'known', sourceUrl: snapshot.sourceUrl });
      continue;
    }
    if (entry.cost) {
      entry.pricing = {
        ...(previous as object ?? {}),
        currency: typeof previous === 'object' && previous && 'currency' in previous ? (previous as { currency?: string }).currency ?? snapshot.currency : snapshot.currency,
        unit: 'per_million_tokens',
        status: 'stale',
      };
      results.push({ modelId: upstream, provider, status: 'stale', sourceUrl: snapshot.sourceUrl, reason: 'official page could not be re-verified; previous amount kept' });
    } else {
      results.push({ modelId: upstream, provider, status: 'unknown', sourceUrl: snapshot.sourceUrl, reason: 'no verified price; refresh failed' });
    }
  }
  return { document: copy, results };
}
