import { RuntimeError, type Json } from '../core/types.ts';
import type { TokenUsage } from '../core/token-usage.ts';

export const MODEL_INPUTS = ['text', 'image'] as const;

export type ModelInput = (typeof MODEL_INPUTS)[number];
/** Transports Graph has actually verified against a provider contract. */
export type ModelApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export const MODEL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];
/** One thinking strength a model accepts. `level` is Pi's own vocabulary (the
 * only value Graph stores and sends); `label` is the name the model's provider
 * uses for that level, which differs between models and vendors. */
export interface ModelThinkingOption {
  level: ModelThinkingLevel;
  label: string;
}
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
  api: ModelApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  /** Input modalities exposed to the Agent kernel. Legacy config defaults to text. */
  input?: ModelInput[];
  /** Whether the model accepts a non-off thinking level. Legacy config without
   * this field is treated as reasoning-capable. */
  reasoning?: boolean;
  /** Default thinking strength for new conversations using this model. */
  defaultThinkingLevel?: ModelThinkingLevel;
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

/** The default thinking strength a model uses when the config names none: the
 * second strongest level the model accepts. One rule for the server, the
 * console and every model added later, so a new model never needs the default
 * written by hand. */
export function defaultThinkingLevelFor(options: readonly { level: string }[]): string | undefined {
  if (!options.length) return undefined;
  return options[options.length - 2]?.level ?? options[options.length - 1]!.level;
}

/** Provider-required HTTP headers that must travel with every model request.
 * OpenCode Go rejects chat completions without a session identifier. */
export function modelRequestHeaders(entry: Pick<ModelEntry, 'provider' | 'baseUrl' | 'headers'>): Record<string, string> | undefined {
  const openCodeGo = entry.provider === 'opencode-go' || entry.baseUrl.includes('opencode.ai/zen/go');
  if (!openCodeGo) return entry.headers;
  return {
    'x-opencode-session': 'graph-console',
    ...(entry.headers ?? {}),
  };
}

export interface CostSummary {
  unknown: boolean;
  amounts: Record<string, number>;
  /** Only set when every known amount shares one currency. */
  amount: number | null;
  currency: string | null;
}

export function estimateCost(usage: TokenUsage, cost?: ModelCost, pricing?: ModelPricing): Json {
  if (!cost) return { unknown: true };
  // A price is a complete set. A missing side (for example `null` from a hand-
  // written document) must never be multiplied as 0: treat it as unknown so an
  // incomplete cost cannot silently bill at zero. Genuine zeroes (free models)
  // are finite numbers and still estimate normally.
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const value = cost[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { unknown: true };
  }
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
