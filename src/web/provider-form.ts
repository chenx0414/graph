/**
 * Pure logic for the two-step model-provider flow (B-1).
 *
 * Step 1 「配置厂商」 validates a provider draft, normalizes the platform
 * catalog served by `GET /api/app/providers` and edits the concurrency limits
 * that live *inside* a provider entry. Step 2 「选择模型」 merges the models
 * probed from `<baseUrl>/models` with the metadata mapped from the vendored
 * models.dev snapshot.
 *
 * The module deliberately stays presentational: it never reads the DOM, never
 * sends a request and never resolves an API key. `Settings.tsx` renders and
 * calls the API; this file owns the rules that the console tests assert.
 */
import {
  MODEL_THINKING_LEVELS,
  type ModelApi,
  type ModelCost,
  type ModelEntry,
  type ModelGrade,
  type ModelInput,
  type ModelPricing,
  type ModelThinkingLevel,
} from '../catalog/models.ts';

export const CUSTOM_PLATFORM_ID = 'custom';

export const PROVIDER_COMPATIBILITIES: readonly { id: ModelApi; label: string }[] = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
];

export type CredentialKind = 'api-key' | 'subscription';

/** One entry of the built-in platform catalog (`GET /api/app/providers`). */
export interface PlatformPreset {
  id: string;
  label: string;
  baseUrl: string;
  api: ModelApi;
  /** Environment variable name the daemon resolves when no keychain entry exists. */
  secretRef: string;
  credentialId: string;
  credentialKind: CredentialKind;
  /** Whether the daemon could already resolve this platform's credential. */
  configured?: boolean;
  notes?: string[];
}

/**
 * Offline fallback only. The daemon catalog is authoritative; this exists so
 * the settings page still renders the supported platforms when the endpoint is
 * unavailable (for example a browser session against an older daemon).
 */
export const FALLBACK_PLATFORMS: readonly PlatformPreset[] = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    api: 'openai-completions',
    secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY',
    credentialId: 'opencode-go',
    credentialKind: 'subscription',
    notes: ['订阅额度；请求需带 x-opencode-session 头，保存后自动附加。'],
  },
  {
    id: 'command-goat',
    label: 'Command Goat',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    api: 'openai-completions',
    secretRef: 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY',
    credentialId: 'command-goat',
    credentialKind: 'subscription',
  },
  {
    id: 'grok',
    label: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    api: 'openai-completions',
    secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN',
    credentialId: 'grok',
    credentialKind: 'subscription',
    notes: ['xAI 订阅：填访问令牌即可。'],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    api: 'openai-completions',
    secretRef: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN',
    credentialId: 'chatgpt',
    credentialKind: 'subscription',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
    secretRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY',
    credentialId: 'deepseek',
    credentialKind: 'api-key',
  },
];

const COMPATIBILITIES = new Set<string>(PROVIDER_COMPATIBILITIES.map(item => item.id));
const GRADES = new Set<string>(['low', 'medium', 'high', 'highest']);
const THINKING = new Set<string>(MODEL_THINKING_LEVELS);
const CREDENTIAL_ID = /^[a-z0-9][a-z0-9-_]*$/;
const SECRET_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ProviderDraft {
  /** Preset id or `custom`. */
  platformId: string;
  name: string;
  baseUrl: string;
  api: ModelApi;
  credentialId: string;
  secretRef: string;
}

export type ProviderDraftField = 'name' | 'baseUrl' | 'api' | 'credentialId' | 'secretRef' | 'key';
export type ProviderDraftErrors = Partial<Record<ProviderDraftField, string>>;

export interface ValidateProviderOptions {
  /** `custom` drafts must type the display name, base URL and compatibility. */
  custom: boolean;
  /** A key is present in the form (desktop keychain push) or already in the environment. */
  hasKey: boolean;
}

export function isCustomPlatform(platformId: string): boolean {
  return platformId === CUSTOM_PLATFORM_ID;
}

export function platformById(platforms: readonly PlatformPreset[], id: string): PlatformPreset | undefined {
  return platforms.find(platform => platform.id === id);
}

export function draftFromPlatform(platform: PlatformPreset): ProviderDraft {
  return {
    platformId: platform.id,
    name: platform.label,
    baseUrl: platform.baseUrl,
    api: platform.api,
    credentialId: platform.credentialId,
    secretRef: platform.secretRef,
  };
}

export function customDraft(): ProviderDraft {
  return {
    platformId: CUSTOM_PLATFORM_ID,
    name: '',
    baseUrl: '',
    api: 'openai-completions',
    credentialId: 'custom',
    secretRef: 'GRAPH_CUSTOM_KEY',
  };
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Field-keyed validation for step 1. Presets only need a key (or a resolvable
 * environment variable); a custom provider also needs a name, base URL and
 * compatibility mode. The API remains the final authority.
 */
export function validateProviderDraft(draft: ProviderDraft, options: ValidateProviderOptions): ProviderDraftErrors {
  const errors: ProviderDraftErrors = {};
  if (options.custom) {
    if (!draft.name.trim()) errors.name = '请填写厂商名';
    if (!draft.baseUrl.trim()) errors.baseUrl = '请填写 Base URL';
    else if (!validHttpUrl(draft.baseUrl.trim())) errors.baseUrl = 'Base URL 需为 http(s) 地址';
    if (!COMPATIBILITIES.has(draft.api)) errors.api = '请选择兼容格式（OpenAI 或 Anthropic）';
  }
  if (!draft.credentialId.trim()) errors.credentialId = '需要凭据 id';
  else if (!CREDENTIAL_ID.test(draft.credentialId)) errors.credentialId = '凭据 id 需以小写字母或数字开头，仅含小写字母、数字、- 和 _';
  if (!draft.secretRef.trim()) errors.secretRef = '需要环境变量名（secretRef）';
  else if (!SECRET_REF.test(draft.secretRef)) errors.secretRef = '凭据引用需为合法环境变量名';
  if (!options.hasKey) {
    errors.key = options.custom
      ? '请填写 API KEY（自定义厂商必须验证一次最小请求）'
      : '请填写 API KEY 或订阅凭据，或在环境中设置对应的环境变量';
  }
  return errors;
}

export function hasProviderErrors(errors: ProviderDraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * Normalize the `GET /api/app/providers` payload. Accepts `{ platforms: [] }`
 * or a bare array and drops entries that cannot describe a provider, so a
 * shape change on the daemon never crashes the settings page.
 */
export function normalizePlatforms(payload: unknown): PlatformPreset[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { platforms?: unknown }).platforms)
      ? (payload as { platforms: unknown[] }).platforms
      : [];
  const platforms: PlatformPreset[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : id;
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
    if (!id || !baseUrl) continue;
    const api: ModelApi = entry.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
    const secretRef = typeof entry.secretRef === 'string' && entry.secretRef.trim() ? entry.secretRef.trim() : `GRAPH_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY`;
    platforms.push({
      id,
      label: label || id,
      baseUrl,
      api,
      secretRef,
      credentialId: typeof entry.credentialId === 'string' && entry.credentialId.trim() ? entry.credentialId.trim() : id,
      credentialKind: entry.credentialKind === 'subscription' ? 'subscription' : 'api-key',
      ...(typeof entry.configured === 'boolean' ? { configured: entry.configured } : {}),
      ...(Array.isArray(entry.notes) ? { notes: entry.notes.filter((note): note is string => typeof note === 'string') } : {}),
    });
  }
  return platforms;
}

/** Request body for `POST /api/app/providers/probe`: an unsaved provider draft
 * plus the credential *reference* (never a secret value). */
export function buildProbePayload(draft: ProviderDraft, modelId?: string) {
  return {
    provider: {
      id: draft.platformId,
      name: draft.name,
      baseUrl: draft.baseUrl.trim(),
      api: draft.api,
      credentialId: draft.credentialId,
      secretRef: draft.secretRef,
    },
    ...(modelId ? { modelId } : {}),
  };
}

export interface ProbeModel {
  id: string;
  name?: string;
}

/** A model row in step 2. `manual` marks ids the user typed because the
 * endpoint does not expose a model list. */
export interface ModelPick {
  modelId: string;
  name?: string;
  selected: boolean;
  manual?: boolean;
}

export function mergeProbeModels(probe: readonly ProbeModel[], previous: readonly ModelPick[]): ModelPick[] {
  const merged: ModelPick[] = previous.map(pick => ({ ...pick }));
  const seen = new Set(merged.map(pick => pick.modelId));
  for (const model of probe) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({ modelId: id, ...(model.name ? { name: model.name } : {}), selected: false });
  }
  return merged;
}

export function addManualModelPick(previous: readonly ModelPick[], modelId: string): ModelPick[] {
  const id = modelId.trim();
  if (!id || previous.some(pick => pick.modelId === id)) return previous.map(pick => ({ ...pick }));
  return [...previous.map(pick => ({ ...pick })), { modelId: id, selected: true, manual: true }];
}

export function selectedProbeModels(picks: readonly ModelPick[]): ModelPick[] {
  return picks.filter(pick => pick.selected);
}

/**
 * Snapshot metadata for one model, mapped by the vendored models.dev module.
 * Every field is optional: a miss must leave blanks, never a fabricated zero.
 */
export interface SnapshotMetadata {
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
  reasoning?: boolean;
  thinkingLevels?: string[];
  defaultThinkingLevel?: string;
  grade?: ModelGrade;
  cost?: ModelCost;
  currency?: string;
  sourceUrl?: string;
  catalogRevision?: string;
}

/** The form-level model fields. `null` means "unknown, leave blank". */
export interface ModelFieldValues {
  contextWindow: number | null;
  maxTokens: number | null;
  input: ModelInput[];
  reasoning: boolean | null;
  thinkingLevels: ModelThinkingLevel[];
  defaultThinkingLevel: ModelThinkingLevel | null;
  grade: ModelGrade | null;
  cost: ModelCost | null;
  pricing: ModelPricing;
}

/** Unknown prices are explicit: no cost object and `status: 'unknown'`, so a
 * later cost estimate stays unknown instead of silently becoming zero. */
export const UNKNOWN_PRICING: ModelPricing = { currency: '', unit: 'per_million_tokens', status: 'unknown' };

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteCost(cost: ModelCost | undefined): ModelCost | null {
  if (!cost) return null;
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (typeof cost[field] !== 'number' || !Number.isFinite(cost[field]) || cost[field] < 0) return null;
  }
  return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
}

function thinkingLevels(values: readonly string[] | undefined): ModelThinkingLevel[] {
  const levels: ModelThinkingLevel[] = [];
  for (const value of values ?? []) {
    if (THINKING.has(value) && !levels.includes(value as ModelThinkingLevel)) levels.push(value as ModelThinkingLevel);
  }
  return levels;
}

export function metadataToFields(metadata: SnapshotMetadata | null | undefined): ModelFieldValues {
  if (!metadata) {
    return {
      contextWindow: null,
      maxTokens: null,
      input: ['text'],
      reasoning: null,
      thinkingLevels: [],
      defaultThinkingLevel: null,
      grade: null,
      cost: null,
      pricing: { ...UNKNOWN_PRICING },
    };
  }
  const cost = finiteCost(metadata.cost);
  const currency = typeof metadata.currency === 'string' ? metadata.currency.trim() : '';
  const defaultThinkingLevel = metadata.defaultThinkingLevel && THINKING.has(metadata.defaultThinkingLevel)
    ? metadata.defaultThinkingLevel as ModelThinkingLevel
    : null;
  const input = (metadata.input ?? []).filter((value): value is ModelInput => value === 'text' || value === 'image');
  return {
    contextWindow: positive(metadata.contextWindow),
    maxTokens: positive(metadata.maxTokens),
    input: input.includes('text') ? input : ['text', ...input],
    reasoning: typeof metadata.reasoning === 'boolean' ? metadata.reasoning : null,
    thinkingLevels: thinkingLevels(metadata.thinkingLevels),
    defaultThinkingLevel,
    grade: metadata.grade && GRADES.has(metadata.grade) ? metadata.grade : null,
    cost,
    pricing: cost
      ? {
          currency: currency || 'USD',
          unit: 'per_million_tokens',
          status: 'known',
          ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
          ...(metadata.catalogRevision ? { catalogRevision: metadata.catalogRevision } : {}),
        }
      : { ...UNKNOWN_PRICING, ...(currency ? { currency } : {}) },
  };
}

/** A model entry under construction. Numeric fields stay optional so an
 * unmatched model shows blank inputs instead of a fake `0`. */
export interface ModelEntryDraft {
  id: string;
  modelId: string;
  provider: string;
  baseUrl: string;
  api: ModelApi;
  credentialId: string;
  grade?: ModelGrade;
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
  reasoning?: boolean;
  defaultThinkingLevel?: ModelThinkingLevel;
  cost?: ModelCost;
  pricing?: ModelPricing;
  /** User-edited fields are never overwritten by a later probe. */
  manual?: boolean;
}

export interface BuildEntryDraftInput {
  id: string;
  provider: string;
  baseUrl: string;
  api: ModelApi;
  credentialId: string;
  modelId: string;
  metadata: SnapshotMetadata | null | undefined;
  grade?: ModelGrade;
}

/**
 * Convert a picked model plus snapshot metadata into the existing ModelEntry
 * shape. Fields the snapshot does not cover are omitted entirely (no zeroes).
 */
export function buildEntryDraft(input: BuildEntryDraftInput): ModelEntryDraft {
  const fields = metadataToFields(input.metadata);
  return {
    id: input.id,
    modelId: input.modelId,
    provider: input.provider,
    baseUrl: input.baseUrl,
    api: input.api,
    credentialId: input.credentialId,
    ...(fields.grade ?? input.grade ? { grade: fields.grade ?? input.grade } : {}),
    ...(fields.contextWindow !== null ? { contextWindow: fields.contextWindow } : {}),
    ...(fields.maxTokens !== null ? { maxTokens: fields.maxTokens } : {}),
    input: fields.input,
    ...(fields.reasoning !== null ? { reasoning: fields.reasoning } : {}),
    ...(fields.defaultThinkingLevel ? { defaultThinkingLevel: fields.defaultThinkingLevel } : {}),
    ...(fields.cost ? { cost: fields.cost } : {}),
    pricing: fields.pricing,
    manual: false,
  };
}

/**
 * Fill only the blanks of an entry from snapshot metadata. Values the user has
 * already typed survive, which keeps a manual ID from being clobbered when the
 * provider list is refreshed.
 */
export function fillEntryFromMetadata(entry: ModelEntryDraft, metadata: SnapshotMetadata | null | undefined): ModelEntryDraft {
  if (entry.manual) return { ...entry };
  const fields = metadataToFields(metadata);
  const next: ModelEntryDraft = { ...entry };
  if (next.contextWindow === undefined && fields.contextWindow !== null) next.contextWindow = fields.contextWindow;
  if (next.maxTokens === undefined && fields.maxTokens !== null) next.maxTokens = fields.maxTokens;
  if (next.grade === undefined && fields.grade) next.grade = fields.grade;
  if (next.reasoning === undefined && fields.reasoning !== null) next.reasoning = fields.reasoning;
  if (next.defaultThinkingLevel === undefined && fields.defaultThinkingLevel) next.defaultThinkingLevel = fields.defaultThinkingLevel;
  if (next.cost === undefined && fields.cost) next.cost = fields.cost;
  if ((next.pricing === undefined || next.pricing.status === 'unknown') && fields.pricing.status === 'known') next.pricing = fields.pricing;
  if (next.pricing === undefined) next.pricing = fields.pricing;
  return next;
}

/** The existing `ModelEntry` shape, except the context/output caps stay
 * optional: an unmatched model must show blank inputs (the server then asks
 * the user to fill them) rather than a fabricated positive number. */
export type PersistedModelEntry = Omit<ModelEntry, 'contextWindow' | 'maxTokens' | 'credentialId'> & {
  contextWindow?: number;
  maxTokens?: number;
  credentialId: string;
};

/** Persist a draft without inventing values for unknown metadata. */
export function draftToModelEntry(draft: ModelEntryDraft): PersistedModelEntry {
  return {
    id: draft.id,
    provider: draft.provider,
    ...(draft.modelId !== draft.id ? { modelId: draft.modelId } : {}),
    grade: draft.grade ?? 'medium',
    api: draft.api,
    baseUrl: draft.baseUrl,
    ...(draft.contextWindow !== undefined ? { contextWindow: draft.contextWindow } : {}),
    ...(draft.maxTokens !== undefined ? { maxTokens: draft.maxTokens } : {}),
    ...(draft.input ? { input: draft.input } : {}),
    ...(draft.reasoning !== undefined ? { reasoning: draft.reasoning } : {}),
    ...(draft.defaultThinkingLevel ? { defaultThinkingLevel: draft.defaultThinkingLevel } : {}),
    credentialId: draft.credentialId,
    ...(draft.cost ? { cost: draft.cost } : {}),
    ...(draft.pricing ? { pricing: draft.pricing } : {}),
  };
}

/** Unique config id for a connection; the upstream model id is kept in `modelId`. */
export function uniqueLocalModelId(providerId: string, modelId: string, taken: readonly string[]): string {
  const base = `${providerId}:${modelId}`;
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export interface ConcurrencyConfig {
  credentials?: Record<string, { sharedLimitGroupId?: string } | undefined>;
  limits?: { credentials?: Record<string, number>; sharedGroups?: Record<string, number> } | undefined;
}

export interface ConcurrencyDraft {
  /** Raw input; `''` means the platform default applies. */
  credentialLimit: string;
  sharedGroupId: string;
  sharedGroupLimit: string;
}

/** Positive integer limits only; anything else means "use the default". */
export function parseLimit(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function readConcurrency(config: ConcurrencyConfig, credentialId: string): ConcurrencyDraft {
  const credentialLimit = config.limits?.credentials?.[credentialId];
  const sharedGroupId = config.credentials?.[credentialId]?.sharedLimitGroupId ?? '';
  const sharedGroupLimit = sharedGroupId ? config.limits?.sharedGroups?.[sharedGroupId] : undefined;
  return {
    credentialLimit: credentialLimit ? String(credentialLimit) : '',
    sharedGroupId,
    sharedGroupLimit: sharedGroupLimit ? String(sharedGroupLimit) : '',
  };
}

/**
 * Write the per-credential cap and the cross-credential shared-group cap back
 * into a config document, in place. Saving applies to new requests only; the
 * runtime keeps counting in-flight calls, so the semantics are unchanged.
 */
export function writeConcurrency<T extends ConcurrencyConfig>(config: T, credentialId: string, draft: ConcurrencyDraft): T {
  if (!credentialId) return config;
  const limits = { ...(config.limits ?? {}) };
  const credentialLimits = { ...(limits.credentials ?? {}) };
  const sharedGroups = { ...(limits.sharedGroups ?? {}) };
  const credential = parseLimit(draft.credentialLimit);
  if (credential === undefined) delete credentialLimits[credentialId];
  else credentialLimits[credentialId] = credential;

  const previousGroup = config.credentials?.[credentialId]?.sharedLimitGroupId;
  if (!config.credentials) config.credentials = {};
  const entry = { ...(config.credentials[credentialId] ?? {}) } as { sharedLimitGroupId?: string };
  const groupId = draft.sharedGroupId.trim();
  if (groupId) entry.sharedLimitGroupId = groupId;
  else delete entry.sharedLimitGroupId;
  config.credentials[credentialId] = entry;

  if (previousGroup && previousGroup !== groupId) delete sharedGroups[previousGroup];
  const groupLimit = parseLimit(draft.sharedGroupLimit);
  if (groupId && groupLimit !== undefined) sharedGroups[groupId] = groupLimit;
  else if (groupId) delete sharedGroups[groupId];

  config.limits = { ...limits, credentials: credentialLimits, sharedGroups };
  return config;
}

/** Provider display name shown on a card: preset label or the typed one. */
export function providerDisplayName(platforms: readonly PlatformPreset[], draft: ProviderDraft): string {
  if (!isCustomPlatform(draft.platformId)) return platformById(platforms, draft.platformId)?.label ?? draft.name ?? draft.platformId;
  return draft.name.trim() || '自定义';
}
