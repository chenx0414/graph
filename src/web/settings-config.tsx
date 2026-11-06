



import { api } from './api.ts';






import { MODEL_GRADES,type ModelGrade,type ModelInput,type ModelTier } from '../catalog/models.ts';



import {
type ModelCostDraft,
type SnapshotMetadata
} from './provider-form.ts';


export type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type RawModel = {
  id: string; provider: string; modelId?: string; grade?: string; api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; baseUrl: string;
  contextWindow?: number; maxTokens?: number; reasoning?: boolean; defaultThinkingLevel?: ModelThinkingLevel; credentialId: string; cost?: ModelCostDraft;
  /** Per-model strengths the server adds to the view; stripped before saving. */
  tier?: ModelTier;
  thinkingOptions?: { level: string; label: string }[];
  input?: ModelInput[];
  pricing?: { currency: string; unit: 'per_million_tokens'; status: 'known' | 'stale' | 'unknown'; sourceUrl?: string; retrievedAt?: string; catalogRevision?: string };
  headers?: Record<string, string>;
};

export type RawCredential = { secretRef: string; displayName?: string; sharedLimitGroupId?: string; platform?: string };

export type RawConfig = {
  version: 1;
  projects?: { id: string; root: string; grants?: string[] }[];
  models?: { entries: RawModel[]; preferences?: Partial<Record<ModelGrade, string[]>> };
  credentials?: Record<string, RawCredential>;
  limits?: { credentials?: Record<string, number>; sharedGroups?: Record<string, number> };
};

export type ConfigResponse = { revision: number; effectiveRevision?: number; config: RawConfig & { path: string | null; credentials?: Record<string, RawCredential & { configured?: boolean }> } };

export type Startup = {
  effectiveRevision?: number;
  /**
   * The code the daemon is running. The console shows it because "committed" and "live" are
   * different facts: a change lands in a checkout, and only a reload makes the daemon run it.
   */
  source?: { root: string; commit: string | null; branch: string | null; dirty: boolean | null };
};

export type ApiError = Error & { code?: string; field?: string };

export const GRADES = MODEL_GRADES;

export type CcSwitchPrice = {
  modelId: string;
  displayName: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion: number;
  cacheCreationCostPerMillion: number;
};

export type CcSwitchPricing = { source: string; updatedAt: number | null; models: CcSwitchPrice[] };

export let ccSwitchPricingRequest: Promise<CcSwitchPricing> | null = null;

export function loadCcSwitchPricing(): Promise<CcSwitchPricing> {
  ccSwitchPricingRequest ??= api<CcSwitchPricing>('/api/model-pricing').catch(() => ({
    source: '~/.cc-switch/model-pricing.json',
    updatedAt: null,
    models: [],
  }));
  return ccSwitchPricingRequest;
}

export function findCcSwitchPrice(modelId: string, pricing: CcSwitchPricing): CcSwitchPrice | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return undefined;
  const exact = pricing.models.find(model => model.modelId.toLowerCase() === normalized);
  if (exact) return exact;
  const leaf = normalized.split('/').at(-1)!;
  return pricing.models.find(model => model.modelId.toLowerCase() === leaf)
    ?? pricing.models.find(model => normalized.endsWith(model.modelId.toLowerCase()) || model.modelId.toLowerCase().endsWith(normalized));
}

export function ccSwitchCost(price: CcSwitchPrice): NonNullable<SnapshotMetadata['cost']> {
  return {
    input: price.inputCostPerMillion,
    output: price.outputCostPerMillion,
    cacheRead: price.cacheReadCostPerMillion,
    cacheWrite: price.cacheCreationCostPerMillion,
  };
}

export function toDraft(config: ConfigResponse['config']): RawConfig {
  const credentials: Record<string, RawCredential> = {};
  for (const [id, credential] of Object.entries(config.credentials ?? {})) {
    const { configured: _configured, ...rest } = credential;
    credentials[id] = rest;
  }
  return {
    version: 1,
    projects: config.projects ?? [],
    ...(config.models ? { models: { ...config.models, entries: config.models.entries } } : {}),
    credentials,
    limits: config.limits ?? {},
  };
}

export function toDocument(draft: RawConfig): RawConfig {
  if (!draft.models) return draft;
  return {
    ...draft,
    models: { ...draft.models, entries: draft.models.entries.map(({ thinkingOptions: _derived, tier: _tier, ...entry }) => entry) },
  };
}

export function mergeSubscriptionCredentials(config: RawConfig, detected: Record<string, string>): { config: RawConfig; changed: boolean } {
  const credentials = { ...(config.credentials ?? {}) };
  let changed = false;
  for (const [provider, secretRef] of Object.entries(detected)) {
    if (credentials[provider]) continue;
    credentials[provider] = { secretRef, displayName: `${provider} 订阅` };
    changed = true;
  }
  return changed ? { config: { ...config, credentials }, changed: true } : { config, changed: false };
}

export type Preparation = { state: string; repoRoot: string | null; projectSubdir: string | null; baselineSha: string | null; detail: { dirty?: number; reason?: string } | null };

export type ProjectRow = { id: string; root: string; archivedAt?: number | null; preparation: Preparation | null };
