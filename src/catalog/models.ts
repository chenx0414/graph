import { RuntimeError, type Json } from '../core/types.ts';
import type { TokenUsage } from '../core/token-usage.ts';

export const MODEL_INPUTS = ['text', 'image'] as const;

export type ModelInput = (typeof MODEL_INPUTS)[number];
export type ModelApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export const MODEL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];
export interface ModelThinkingOption {
  level: ModelThinkingLevel;
  label: string;
}
export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }
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
  input?: ModelInput[];
  reasoning?: boolean;
  defaultThinkingLevel?: ModelThinkingLevel;
  cost?: ModelCost;
  pricing?: ModelPricing;
  headers?: Record<string, string>;
  credentialId?: string;
  modelId?: string;
}

export function defaultThinkingLevelFor(options: readonly { level: string }[]): string | undefined {
  if (!options.length) return undefined;
  return options[options.length - 2]?.level ?? options[options.length - 1]!.level;
}

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
  amount: number | null;
  currency: string | null;
}

export function estimateCost(usage: TokenUsage, cost?: ModelCost, pricing?: ModelPricing): Json {
  if (!cost) return { unknown: true };
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const value = cost[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { unknown: true };
  }
  const amount = (usage.input * cost.input + usage.output * cost.output + usage.cacheRead * cost.cacheRead + usage.cacheWrite * cost.cacheWrite) / 1_000_000;
  if (!Number.isFinite(amount)) return { unknown: true };
  return {
    amount,
    ...(pricing ? { currency: pricing.currency, unit: pricing.unit, ...(pricing.catalogRevision ? { priceRevision: pricing.catalogRevision } : {}) } : {}),
  };
}

export function modelIdentity(entry: Pick<ModelEntry, 'id' | 'modelId'>) {
  return entry.modelId ?? entry.id;
}
