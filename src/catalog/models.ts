import { RuntimeError, type Json } from '../core/types.ts';
import type { TokenUsage } from '../runtime/call-broker.ts';

export type ModelGrade = 'low' | 'medium' | 'high' | 'highest';
/** Transports Graph has actually verified against a provider contract. */
export type ModelApi = 'openai-completions' | 'anthropic-messages';
export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }
/** Price provenance. Amounts are normalized per million tokens; `unknown`
 * means no usable price (never zero) and `stale` marks a snapshot to refresh. */
export interface ModelPricing {
  currency: string;
  unit: 'per_million_tokens';
  sourceUrl?: string;
  retrievedAt?: string;
  catalogRevision?: string;
  status: 'known' | 'stale' | 'unknown';
}
export interface ModelEntry {
  id: string;
  provider: string;
  grade: ModelGrade;
  api: ModelApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  /** Whether the model accepts a non-off thinking level. Legacy config without
   * this field is treated as reasoning-capable. */
  reasoning?: boolean;
  cost?: ModelCost;
  pricing?: ModelPricing;
  /** Extra HTTP headers for gateways that require routing hints (for example
   * x-opencode-session on OpenCode GO). Merged over provider defaults. */
  headers?: Record<string, string>;
  /** Credential binding from the daemon configuration; absent in legacy entries. */
  credentialId?: string;
  /** Upstream model id sent to the provider when `id` is a local connection
   * identity (same provider model id on two platforms must not overwrite). */
  modelId?: string;
}

export interface CostSummary {
  unknown: boolean;
  amounts: Record<string, number>;
  /** Only set when every known amount shares one currency. */
  amount: number | null;
  currency: string | null;
}

/** Sum invocation costs per currency. Amounts in different currencies are
 * never added into one meaningless number; unknown stays unknown. */
export function sumCosts(costs: (Json | null | undefined)[]): CostSummary {
  const amounts: Record<string, number> = {};
  let unknown = false;
  for (const cost of costs) {
    if (!cost || typeof cost !== 'object' || Array.isArray(cost)) { unknown = true; continue; }
    const record = cost as Record<string, unknown>;
    if (record.unknown === true || typeof record.amount !== 'number' || !Number.isFinite(record.amount)) { unknown = true; continue; }
    const currency = typeof record.currency === 'string' && record.currency ? record.currency : '?';
    amounts[currency] = (amounts[currency] ?? 0) + record.amount;
  }
  const currencies = Object.keys(amounts);
  return {
    unknown,
    amounts,
    amount: currencies.length === 1 ? amounts[currencies[0]!]! : null,
    currency: currencies.length === 1 ? currencies[0]! : null,
  };
}

export function mergeCosts(summaries: CostSummary[]): CostSummary {
  const amounts: Record<string, number> = {};
  let unknown = false;
  for (const summary of summaries) {
    unknown = unknown || summary.unknown;
    for (const [currency, amount] of Object.entries(summary.amounts)) amounts[currency] = (amounts[currency] ?? 0) + amount;
  }
  const currencies = Object.keys(amounts);
  return {
    unknown,
    amounts,
    amount: currencies.length === 1 ? amounts[currencies[0]!]! : null,
    currency: currencies.length === 1 ? currencies[0]! : null,
  };
}

export function parseDefinitionVersion(value: string) {
  const match = /^(.*)@(\d+)$/.exec(value.trim());
  if (match) return { id: match[1]!, version: Number(match[2]) };
  if (!value.trim()) throw new RuntimeError('invalid_input', 'A definition version is required');
  return { id: value.trim(), version: 1 };
}

export function estimateCost(usage: TokenUsage, cost?: ModelCost, pricing?: ModelPricing): Json {
  if (!cost) return { unknown: true };
  const amount = (usage.input * cost.input + usage.output * cost.output + usage.cacheRead * cost.cacheRead + usage.cacheWrite * cost.cacheWrite) / 1_000_000;
  if (!Number.isFinite(amount)) return { unknown: true };
  // The currency and price revision are frozen with the amount so a later
  // catalog refresh cannot rewrite historical cost records.
  return {
    amount,
    ...(pricing ? { currency: pricing.currency, unit: pricing.unit, ...(pricing.catalogRevision ? { priceRevision: pricing.catalogRevision } : {}) } : {}),
  };
}

/** Underlying provider model identity: two config connections sharing one
 * upstream model (different id/endpoint/key) are the same model for review
 * independence, and history stored the config id. */
export function modelIdentity(entry: Pick<ModelEntry, 'id' | 'modelId'>) {
  return entry.modelId ?? entry.id;
}

/** Pick a configured model; review nodes pass exclude for implementer models used this round. */
export function selectModel(input: {
  requested?: string;
  grade: ModelGrade;
  directory: ModelEntry[];
  preferences?: Partial<Record<ModelGrade, string[]>>;
  exclude?: string[];
}) {
  const blocked = new Set(input.exclude ?? []);
  const usable = input.directory.filter(model => !blocked.has(modelIdentity(model)) && !blocked.has(model.id));
  const requested = input.requested ? usable.find(model => model.id === input.requested) : undefined;
  if (requested) return requested;
  const preferred = (input.preferences?.[input.grade] ?? []).map(id => usable.find(model => model.id === id)).find(model => model);
  if (preferred) return preferred;
  return usable.find(model => model.grade === input.grade);
}
