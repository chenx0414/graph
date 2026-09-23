/**
 * models.dev metadata snapshot + pure mapping (B-1).
 *
 * `models-dev.snapshot.json` is a build-time vendored copy of the models.dev
 * community catalog (refresh with `node --run catalog:refresh`). This module
 * only maps that frozen data onto Graph's model fields; it performs no network
 * call and never inspects the provider endpoint.
 *
 * Guardrails:
 * - a missing snapshot, a provider that is not in the catalog, or a model id
 *   that is not listed all yield `null`, so the caller leaves the fields empty
 *   and marks the price unknown rather than inventing zeros;
 * - thinking levels are only reported when models.dev spells them out for the
 *   model and they map onto `MODEL_THINKING_LEVELS`; an unsupported vocabulary
 *   yields no levels instead of a guessed one;
 * - prices are models.dev's USD amounts per million tokens, carried with their
 *   source and revision so a later refresh cannot rewrite a frozen cost.
 */
import { readFileSync } from 'node:fs';
import { MODEL_THINKING_LEVELS, type ModelCost, type ModelInput, type ModelThinkingLevel } from './models.ts';

export const MODELS_DEV_SOURCE_URL = 'https://models.dev/api.json';
export const MODELS_DEV_LICENSE = 'models.dev community catalog (MIT). Attribution: https://models.dev';

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
  fetchedAt?: string;
  sourceUrl?: string;
  license?: string;
  providers: Record<string, ModelsDevProvider>;
}

/** Mapped metadata for one model; every field is optional and an absent field
 * means "the snapshot does not say", never zero. */
export interface ModelMetadata {
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
  reasoning?: boolean;
  thinkingLevels?: ModelThinkingLevel[];
  defaultThinkingLevel?: ModelThinkingLevel;
  cost?: ModelCost;
  currency?: string;
  sourceUrl?: string;
  catalogRevision?: string;
}

/**
 * models.dev publishes some first-party platforms under a different provider
 * id than the console's platform id (for example the Grok console entry maps
 * to the `xai` catalog entry). The first candidate that exists in the snapshot
 * wins; an unknown platform still resolves to `null`.
 */
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
  const input = typeof cost.input === 'number' && Number.isFinite(cost.input) ? cost.input : undefined;
  const output = typeof cost.output === 'number' && Number.isFinite(cost.output) ? cost.output : undefined;
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = typeof cost.cache_read === 'number' && Number.isFinite(cost.cache_read) ? cost.cache_read : 0;
  const cacheWrite = typeof cost.cache_write === 'number' && Number.isFinite(cost.cache_write) ? cost.cache_write : 0;
  return { input, output, cacheRead, cacheWrite };
}

/** Only effort vocabularies the repository already models are reported; other
 * option types (toggle, budget_tokens) carry no discrete level. */
function thinkingLevels(model: ModelsDevModel): ModelThinkingLevel[] {
  const found: ModelThinkingLevel[] = [];
  for (const option of Array.isArray(model.reasoning_options) ? model.reasoning_options : []) {
    if (!option || option.type !== 'effort') continue;
    for (const value of Array.isArray(option.values) ? option.values : []) {
      const level = THINKING_ALIASES[String(value).trim().toLowerCase()];
      if (level && !found.includes(level)) found.push(level);
    }
  }
  return MODEL_THINKING_LEVELS.filter(level => found.includes(level));
}

function inputModalities(model: ModelsDevModel): ModelInput[] | undefined {
  const inputs = Array.isArray(model.modalities?.input) ? model.modalities.input.map(value => String(value)) : [];
  if (!inputs.length) return undefined;
  // `pdf`/`video`/`audio` are not Graph input modalities; only image support
  // is promoted onto the existing text/image pair.
  return inputs.includes('image') ? ['text', 'image'] : ['text'];
}

/** Normalize either the vendored wrapper or a bare provider map. */
export function normalizeModelsDevSnapshot(raw: unknown): ModelsDevSnapshot {
  const root = record(raw);
  if (!root) return { providers: {} };
  const { providers, ...rest } = root;
  if (providers !== undefined) {
    const mapped = record(providers) ?? {};
    return {
      ...(typeof rest.fetchedAt === 'string' ? { fetchedAt: rest.fetchedAt } : {}),
      ...(typeof rest.sourceUrl === 'string' ? { sourceUrl: rest.sourceUrl } : {}),
      ...(typeof rest.license === 'string' ? { license: rest.license } : {}),
      providers: mapped as Record<string, ModelsDevProvider>,
    };
  }
  return { providers: root as Record<string, ModelsDevProvider> };
}

let cached: ModelsDevSnapshot | undefined;

/** The vendored snapshot that ships with the build. Parsed once per process. */
export function builtinModelsDevSnapshot(): ModelsDevSnapshot {
  if (!cached) {
    const text = readFileSync(new URL('./models-dev.snapshot.json', import.meta.url), 'utf8');
    cached = normalizeModelsDevSnapshot(JSON.parse(text));
  }
  return cached;
}

function resolveProvider(snapshot: ModelsDevSnapshot, providerHint: string): ModelsDevProvider | undefined {
  const hint = providerHint.trim().toLowerCase();
  if (!hint) return undefined;
  const candidates = [...(PROVIDER_ALIASES[hint] ?? []), hint];
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
  const direct = models[id];
  if (direct) return direct;
  for (const [key, model] of Object.entries(models)) {
    if (key === id || model?.id === id) return model;
  }
  return undefined;
}

/**
 * Map one provider/model pair from the models.dev snapshot onto Graph's model
 * metadata. Returns `null` when the snapshot or the provider/model is missing;
 * a matched model without a price simply omits `cost` (never a zero price).
 */
export function lookupModelMetadata(providerHint: string, modelId: string, snapshot: ModelsDevSnapshot = builtinModelsDevSnapshot()): ModelMetadata | null {
  if (!snapshot || !snapshot.providers) return null;
  const provider = resolveProvider(snapshot, providerHint);
  if (!provider) return null;
  const model = resolveModel(provider, modelId);
  if (!model) return null;

  const contextWindow = positiveNumber(model.limit?.context);
  const maxTokens = positiveNumber(model.limit?.output);
  const input = inputModalities(model);
  const reasoning = typeof model.reasoning === 'boolean' ? model.reasoning : undefined;
  const levels = thinkingLevels(model);
  const cost = optionalCost(model.cost);
  const sourceUrl = typeof snapshot.sourceUrl === 'string' && snapshot.sourceUrl ? snapshot.sourceUrl : MODELS_DEV_SOURCE_URL;
  const catalogRevision = snapshot.fetchedAt ? `models-dev.${snapshot.fetchedAt}` : undefined;

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input ? { input } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(levels.length ? { thinkingLevels: levels } : {}),
    ...(reasoning && levels.includes('medium') ? { defaultThinkingLevel: 'medium' as ModelThinkingLevel } : {}),
    ...(cost ? { cost } : {}),
    ...(cost ? { currency: typeof model.cost?.currency === 'string' && model.cost.currency ? model.cost.currency : 'USD' } : {}),
    sourceUrl,
    ...(catalogRevision ? { catalogRevision } : {}),
  };
}
