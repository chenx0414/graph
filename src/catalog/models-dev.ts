import { readFileSync } from 'node:fs';
import { MODEL_THINKING_LEVELS, type ModelCost, type ModelInput, type ModelThinkingLevel, type ModelThinkingOption } from './models.ts';

export const MODELS_DEV_SOURCE_URL = 'https://models.dev/api.json';
export const MODELS_DEV_ATTRIBUTION = 'models.dev community catalog (MIT). Attribution: https://models.dev';
export interface ModelsDevReasoningOption {
  type?: string;
  values?: unknown[];
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  modalities?: { input?: unknown[]; output?: unknown[] };
  limit?: { context?: unknown; output?: unknown };
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown; currency?: unknown };
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

export interface ModelsDevSnapshot {
  sourceUrl?: string;
  fetchedAt?: string;
  attribution?: string;
  providers: Record<string, ModelsDevProvider>;
}

export interface CatalogProvenance {
  sourceUrl: string;
  retrievedAt: string | undefined;
  catalogRevision: string | undefined;
  attribution: string;
}

export interface ModelMetadata {
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
  reasoning?: boolean;
  thinkingLevels?: ModelThinkingLevel[];
  thinkingOptions?: ModelThinkingOption[];
  defaultThinkingLevel?: ModelThinkingLevel;
  cost?: ModelCost;
  currency?: string;
  sourceUrl?: string;
  catalogRevision?: string;
}

const PROVIDER_ALIASES: Record<string, string[]> = {
  'opencode-go': ['opencode-go', 'opencode'],
  'command-goat': ['command-goat', 'commandcode'],
  grok: ['xai', 'grok'],
  chatgpt: ['openai', 'chatgpt'],
  deepseek: ['deepseek'],
  openai: ['openai'],
  anthropic: ['anthropic'],
  gemini: ['google', 'gemini'],
  google: ['google'],
  openrouter: ['openrouter'],
};

const THINKING_ALIASES: Record<string, ModelThinkingLevel> = {
  none: 'off',
  off: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalCost(cost: ModelsDevModel['cost']): ModelCost | undefined {
  if (!cost) return undefined;
  const input = finiteAmount(cost.input);
  const output = finiteAmount(cost.output);
  const cacheRead = finiteAmount(cost.cache_read);
  const cacheWrite = finiteAmount(cost.cache_write);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

function finiteAmount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function thinkingOptions(model: ModelsDevModel): ModelThinkingOption[] {
  const found = new Map<ModelThinkingLevel, string>();
  for (const option of Array.isArray(model.reasoning_options) ? model.reasoning_options : []) {
    if (!option || option.type !== 'effort') continue;
    for (const value of Array.isArray(option.values) ? option.values : []) {
      const label = String(value).trim();
      const level = THINKING_ALIASES[label.toLowerCase()];
      if (level && !found.has(level)) found.set(level, label);
    }
  }
  return MODEL_THINKING_LEVELS.filter(level => found.has(level)).map(level => ({ level, label: found.get(level)! }));
}

function thinkingLevels(model: ModelsDevModel): ModelThinkingLevel[] {
  return thinkingOptions(model).map(option => option.level);
}

function inputModalities(model: ModelsDevModel): ModelInput[] | undefined {
  const inputs = Array.isArray(model.modalities?.input) ? model.modalities.input.map(value => String(value)) : [];
  if (!inputs.length) return undefined;
  return inputs.includes('image') ? ['text', 'image'] : ['text'];
}

export function normalizeModelsDevSnapshot(raw: unknown): ModelsDevSnapshot {
  const root = record(raw);
  if (!root) return { providers: {} };
  const meta = record(root._meta) ?? {};
  const { providers, _meta: _ignoredMeta, ...rest } = root;
  if (providers !== undefined) {
    const mapped = record(providers) ?? {};
    const sourceUrl = meta.sourceUrl ?? rest.sourceUrl ?? rest.license;
    const fetchedAt = meta.fetchedAt ?? rest.fetchedAt;
    const attribution = meta.attribution ?? meta.license ?? rest.attribution ?? rest.license;
    return {
      ...(typeof sourceUrl === 'string' ? { sourceUrl } : {}),
      ...(typeof fetchedAt === 'string' ? { fetchedAt } : {}),
      ...(typeof attribution === 'string' ? { attribution } : {}),
      providers: mapped as Record<string, ModelsDevProvider>,
    };
  }
  return { providers: root as Record<string, ModelsDevProvider> };
}

const SNAPSHOT_URL = new URL('./models-dev.snapshot.json', import.meta.url);

let cached: ModelsDevSnapshot | undefined;

if (SNAPSHOT_URL.protocol !== 'file:') {
  const response = await fetch(SNAPSHOT_URL);
  cached = normalizeModelsDevSnapshot(await response.json());
}

export function builtinModelsDevSnapshot(): ModelsDevSnapshot {
  if (!cached) cached = normalizeModelsDevSnapshot(JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')));
  return cached;
}

export function catalogProvenance(snapshot?: unknown): CatalogProvenance {
  const source = snapshot === undefined ? builtinModelsDevSnapshot() : normalizeModelsDevSnapshot(snapshot);
  const retrievedAt = source.fetchedAt;
  return {
    sourceUrl: source.sourceUrl ?? MODELS_DEV_SOURCE_URL,
    retrievedAt,
    catalogRevision: retrievedAt ? `models-dev.${retrievedAt}` : undefined,
    attribution: source.attribution ?? MODELS_DEV_ATTRIBUTION,
  };
}

function resolveProvider(snapshot: ModelsDevSnapshot, providerHint: string): ModelsDevProvider | undefined {
  const hint = providerHint.trim().toLowerCase();
  if (!hint) return undefined;
  const accountBase = hint.replace(/-\d+$/, '');
  const platform = accountBase !== hint && PROVIDER_ALIASES[accountBase] ? accountBase : hint;
  const candidates = [...(PROVIDER_ALIASES[platform] ?? []), platform];
  for (const candidate of candidates) {
    const provider = snapshot.providers[candidate];
    if (provider) return provider;
  }
  return undefined;
}

function resolveModel(provider: ModelsDevProvider, modelId: string): ModelsDevModel | undefined {
  const id = modelId.trim();
  if (!id) return undefined;
  const models = provider.models;
  if (!models) return undefined;
  const segment = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const direct = models[id] ?? models[segment];
  if (direct) return direct;
  for (const [key, model] of Object.entries(models)) {
    if (key === id || key === segment) return model;
    if (key.endsWith(`/${segment}`) || key.slice(key.lastIndexOf('/') + 1) === segment) return model;
    if (model?.id === id || model?.id === segment) return model;
  }
  return undefined;
}

export function lookupModelMetadata(providerHint: string, modelId: string, snapshot?: unknown): ModelMetadata | null {
  const source = snapshot === undefined ? builtinModelsDevSnapshot() : normalizeModelsDevSnapshot(snapshot);
  if (!source || !source.providers) return null;
  const provider = resolveProvider(source, providerHint);
  if (!provider) return null;
  const model = resolveModel(provider, modelId);
  if (!model) return null;

  const contextWindow = positiveNumber(model.limit?.context);
  const maxTokens = positiveNumber(model.limit?.output);
  const input = inputModalities(model);
  const reasoning = typeof model.reasoning === 'boolean' ? model.reasoning : undefined;
  const options = thinkingOptions(model);
  const levels = options.map(option => option.level);
  const cost = optionalCost(model.cost);
  const provenance = catalogProvenance(source);

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input ? { input } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(levels.length ? { thinkingLevels: levels } : {}),
    ...(options.length ? { thinkingOptions: options } : {}),

    ...(cost ? { cost } : {}),
    ...(cost ? { currency: typeof model.cost?.currency === 'string' && model.cost.currency ? model.cost.currency : 'USD' } : {}),
    sourceUrl: provenance.sourceUrl,
    ...(provenance.catalogRevision ? { catalogRevision: provenance.catalogRevision } : {}),
  };
}
