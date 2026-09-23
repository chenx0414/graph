/**
 * Pure logic for the two-step model-provider flow (B-1).
 *
 * Step 1 「配置厂商」 validates a provider draft, normalizes the platform
 * catalog served by `GET /api/providers` and edits the concurrency limits that
 * live *inside* a provider entry. Step 2 「选择模型」 merges the models probed
 * from `<baseUrl>/models` with the metadata mapped from the vendored models.dev
 * snapshot.
 *
 * The field names here mirror the daemon contract in `src/server/providers.ts`:
 * the display name is `label`, the credential reference is `credentialRef`
 * (never `name` / `secretRef`), and the probe body carries a `requestId`
 * idempotency key. This module stays presentational: it never reads the DOM,
 * never sends a request and never resolves an API key.
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

export const PROVIDER_ROUTES = {
  list: '/api/providers',
  probe: '/api/providers/probe',
} as const;

export const PROVIDER_COMPATIBILITIES: readonly { id: ModelApi; label: string }[] = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
];

export type CredentialKind = 'api-key' | 'subscription';

/** One entry of the platform catalog served by `GET /api/providers`
 * (`PlatformView` in src/server/providers.ts). */
export interface PlatformPreset {
  id: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  /** Environment variable / keychain entry name; config stores only this. */
  credentialRef: string;
  credentialKind: CredentialKind;
  /** False when the vendor has no `<baseUrl>/models` listing endpoint. */
  modelsListSupported: boolean;
  custom?: boolean;
  /** Whether the daemon could already resolve this platform's credential. */
  credentialConfigured?: boolean;
  headers?: Record<string, string>;
  docsUrl?: string;
  notes?: string[];
}

/** Offline fallback only. The daemon catalog is authoritative; this mirrors the
 * built-in presets so the page still renders when the endpoint is unreachable. */
export const FALLBACK_PLATFORMS: readonly PlatformPreset[] = [
  { id: 'opencode-go', label: 'OpenCode Go', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', credentialRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', credentialKind: 'subscription', modelsListSupported: false, headers: { 'x-opencode-session': 'graph-console' }, notes: ['订阅凭据；端点不支持 /models 时请手动添加模型 id。'] },
  { id: 'command-goat', label: 'Command Goat', api: 'openai-completions', baseUrl: 'https://api.commandcode.ai/provider/v1', credentialRef: 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY', credentialKind: 'subscription', modelsListSupported: true },
  { id: 'grok', label: 'Grok', api: 'openai-completions', baseUrl: 'https://api.x.ai/v1', credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', credentialKind: 'subscription', modelsListSupported: true },
  { id: 'chatgpt', label: 'ChatGPT', api: 'openai-completions', baseUrl: 'https://chatgpt.com/backend-api/codex', credentialRef: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN', credentialKind: 'subscription', modelsListSupported: true },
  { id: 'deepseek', label: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', credentialRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY', credentialKind: 'api-key', modelsListSupported: true },
  { id: CUSTOM_PLATFORM_ID, label: '自定义', api: 'openai-completions', baseUrl: '', credentialRef: 'GRAPH_PROVIDER_API_KEY', credentialKind: 'api-key', modelsListSupported: true, custom: true, credentialConfigured: false },
];

const COMPATIBILITIES = new Set<string>(PROVIDER_COMPATIBILITIES.map(item => item.id));
const GRADES = new Set<string>(['low', 'medium', 'high', 'highest']);
const THINKING = new Set<string>(MODEL_THINKING_LEVELS);
const CREDENTIAL_ID = /^[a-z0-9][a-z0-9-_]*$/;
const SECRET_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ProviderDraft {
  /** Preset id or `custom` (sent as the probe `provider.id`). */
  platformId: string;
  /** Display name; required for a custom provider only. */
  label: string;
  baseUrl: string;
  api: ModelApi;
  /** Config credential key (the `credentials[<id>]` entry). */
  credentialId: string;
  /** Environment variable / keychain entry name, sent as `credentialRef`. */
  credentialRef: string;
}

export type ProviderDraftField = 'label' | 'baseUrl' | 'api' | 'credentialId' | 'credentialRef' | 'key';
export type ProviderDraftErrors = Partial<Record<ProviderDraftField, string>>;

export interface ValidateProviderOptions {
  /** `custom` drafts must type the display name, base URL and compatibility. */
  custom: boolean;
  /** A key is present in the form (desktop keychain push) or already resolved. */
  hasKey: boolean;
}

export function isCustomPlatform(platformId: string): boolean {
  return platformId === CUSTOM_PLATFORM_ID;
}

export function platformById(platforms: readonly PlatformPreset[], id: string): PlatformPreset | undefined {
  return platforms.find(platform => platform.id === id);
}

export function draftFromPlatform(platform: PlatformPreset): ProviderDraft {
  const custom = platform.custom === true || isCustomPlatform(platform.id);
  return {
    platformId: platform.id,
    label: custom ? '' : platform.label,
    baseUrl: custom ? '' : platform.baseUrl,
    api: platform.api,
    credentialId: platform.id,
    credentialRef: platform.credentialRef,
  };
}

export function customDraft(): ProviderDraft {
  return { platformId: CUSTOM_PLATFORM_ID, label: '', baseUrl: '', api: 'openai-completions', credentialId: 'custom', credentialRef: 'GRAPH_PROVIDER_API_KEY' };
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
 * Field-keyed validation for step 1, matching the daemon's own wording in
 * `src/server/providers.ts` (which remains the authority). Presets only need a
 * key (or a resolvable credentialRef); a custom provider also needs a label,
 * base URL and compatibility mode.
 */
export function validateProviderDraft(draft: ProviderDraft, options: ValidateProviderOptions): ProviderDraftErrors {
  const errors: ProviderDraftErrors = {};
  if (options.custom) {
    if (!draft.label.trim()) errors.label = '自定义厂商必须填写厂商名';
    if (!draft.baseUrl.trim()) errors.baseUrl = '自定义厂商必须填写 Base URL';
    else if (!validHttpUrl(draft.baseUrl.trim())) errors.baseUrl = 'Base URL 必须是 http(s) 绝对地址';
    if (!COMPATIBILITIES.has(draft.api)) errors.api = '兼容格式必须是 openai-completions 或 anthropic-messages';
  }
  if (!draft.credentialId.trim()) errors.credentialId = '需要凭据 id';
  else if (!CREDENTIAL_ID.test(draft.credentialId)) errors.credentialId = '凭据 id 需以小写字母或数字开头，仅含小写字母、数字、- 和 _';
  if (!draft.credentialRef.trim()) errors.credentialRef = '需要凭据引用（环境变量名或钥匙串条目）';
  else if (!SECRET_REF.test(draft.credentialRef)) errors.credentialRef = 'credentialRef 必须是环境变量名';
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

export interface CredentialResolution {
  resolved: boolean;
  /** Environment variable name the daemon resolves (platform.credentialRef). */
  credentialRef: string;
}

/** Models under a provider whose credential is unresolved cannot be selected
 * or dispatched. The UI shows this reason instead of letting the user pick. */
export function selectionBlockedReason(input: CredentialResolution): string | null {
  if (input.resolved) return null;
  return `凭据未解析：请设置环境变量 ${input.credentialRef || '（对应环境变量名）'}，或在桌面端把密钥保存到钥匙串后再选择模型`;
}

/**
 * Normalize the `GET /api/providers` payload. Accepts `{ platforms: [] }`
 * (or a bare array) and drops entries without an id, so a shape change on the
 * daemon never crashes the settings page.
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
    if (!id) continue;
    const credentialRef = typeof entry.credentialRef === 'string' && entry.credentialRef.trim()
      ? entry.credentialRef.trim()
      : `GRAPH_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY`;
    platforms.push({
      id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id,
      api: entry.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '',
      credentialRef,
      credentialKind: entry.credentialKind === 'subscription' ? 'subscription' : 'api-key',
      modelsListSupported: entry.modelsListSupported !== false,
      ...(entry.custom === true || id === CUSTOM_PLATFORM_ID ? { custom: true } : {}),
      ...(typeof entry.credentialConfigured === 'boolean' ? { credentialConfigured: entry.credentialConfigured } : {}),
      ...(entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers) ? { headers: entry.headers as Record<string, string> } : {}),
      ...(typeof entry.docsUrl === 'string' ? { docsUrl: entry.docsUrl } : {}),
      ...(Array.isArray(entry.notes) ? { notes: entry.notes.filter((note): note is string => typeof note === 'string') } : {}),
    });
  }
  return platforms;
}

/** Console platform catalog request (session-cookie `/api` face). */
export function platformsRequest(): { url: string } {
  return { url: PROVIDER_ROUTES.list };
}

/** Body for `POST /api/providers/probe`: an unsaved provider draft, the
 * credential *reference* (never a secret value) and the idempotency key. */
export function probePayload(draft: ProviderDraft, requestId: string, modelId?: string) {
  return {
    requestId,
    provider: {
      id: draft.platformId,
      label: draft.label,
      baseUrl: draft.baseUrl.trim(),
      api: draft.api,
      credentialRef: draft.credentialRef,
    },
    ...(modelId ? { modelId } : {}),
  };
}

/** One-shot probe request; `requestId` makes the retry safe on the daemon. */
export function probeRequest(draft: ProviderDraft, requestId: string, modelId?: string): {
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: string };
} {
  return {
    url: PROVIDER_ROUTES.probe,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(probePayload(draft, requestId, modelId)) },
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
/** A hand-edited price may be partially typed while the user works; a price is
 * only a value once all four sides are known. Partial sides are an error and are
 * never persisted as 0 (a zero would be billed as a real, free price). */
export interface ModelCostDraft {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const MODEL_COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function finitePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** `null` means the price is fine (complete or entirely absent); a string is the
 * explicit reason a partial/negative price blocks saving. */
export function costError(cost?: ModelCostDraft | null): string | null {
  if (!cost) return null;
  const present = MODEL_COST_FIELDS.filter(field => cost[field] !== undefined);
  if (!present.length) return null;
  if (present.length < MODEL_COST_FIELDS.length) return '价格需要成套填写（输入/输出/缓存读/缓存写）；缺失项不会按 0 计算';
  return MODEL_COST_FIELDS.every(field => finitePrice(cost[field]))
    ? null
    : '价格需要成套填写（输入/输出/缓存读/缓存写）；缺失项不会按 0 计算';
}

/** The complete `ModelCost`, or null when the price is absent/partial. */
export function completeCost(cost?: ModelCostDraft | null): ModelCost | null {
  if (!cost) return null;
  if (!MODEL_COST_FIELDS.every(field => finitePrice(cost[field]))) return null;
  return { input: cost.input!, output: cost.output!, cacheRead: cost.cacheRead!, cacheWrite: cost.cacheWrite! };
}

/** Update one price side. Clearing a side leaves the cost partial (never 0). */
export function withCostField(cost: ModelCostDraft | undefined, field: keyof ModelCost, value: number | undefined): ModelCostDraft | undefined {
  const next: ModelCostDraft = { ...(cost ?? {}) };
  if (value === undefined || !Number.isFinite(value)) delete next[field];
  else next[field] = value;
  return Object.keys(next).length ? next : undefined;
}

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
  cost?: ModelCostDraft;
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
  const grade = fields.grade ?? input.grade;
  return {
    id: input.id,
    modelId: input.modelId,
    provider: input.provider,
    baseUrl: input.baseUrl,
    api: input.api,
    credentialId: input.credentialId,
    ...(grade ? { grade } : {}),
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
 * the user to fill them) rather than a fabricated positive number. `grade` is
 * optional too: the models.dev snapshot carries no grade, so the user must
 * choose it explicitly instead of inheriting a silent default. */
export type PersistedModelEntry = Omit<ModelEntry, 'contextWindow' | 'maxTokens' | 'credentialId' | 'grade'> & {
  contextWindow?: number;
  maxTokens?: number;
  credentialId: string;
  grade?: ModelGrade;
};

/** Persist a draft without inventing values for unknown metadata: no fake
 * grade, and a price only when all four sides are known. */
export function draftToModelEntry(draft: ModelEntryDraft): PersistedModelEntry {
  const cost = completeCost(draft.cost);
  const pricing = cost
    ? (draft.pricing && draft.pricing.status !== 'unknown'
        ? draft.pricing
        : { currency: draft.pricing?.currency || 'USD', unit: 'per_million_tokens' as const, status: 'known' as const, sourceUrl: 'manual' })
    : draft.pricing;
  return {
    id: draft.id,
    provider: draft.provider,
    ...(draft.modelId !== draft.id ? { modelId: draft.modelId } : {}),
    ...(draft.grade ? { grade: draft.grade } : {}),
    api: draft.api,
    baseUrl: draft.baseUrl,
    ...(draft.contextWindow !== undefined ? { contextWindow: draft.contextWindow } : {}),
    ...(draft.maxTokens !== undefined ? { maxTokens: draft.maxTokens } : {}),
    ...(draft.input ? { input: draft.input } : {}),
    ...(draft.reasoning !== undefined ? { reasoning: draft.reasoning } : {}),
    ...(draft.defaultThinkingLevel ? { defaultThinkingLevel: draft.defaultThinkingLevel } : {}),
    credentialId: draft.credentialId,
    ...(cost ? { cost } : {}),
    ...(pricing ? { pricing } : {}),
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

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface ModelValidationFields {
  /** Required by the config parser; unknown means the user must choose. */
  grade?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  /** Partial while the user types; a partial price is an error. */
  cost?: ModelCostDraft | null;
}

export interface ModelFieldErrors {
  contextWindow?: string;
  maxTokens?: string;
  grade?: string;
  cost?: string;
}

/** `contextWindow`/`maxTokens`/`grade` are required by the config parser. A
 * model whose snapshot hit did not cover them must stay unsaved until the user
 * provides them; every other field may stay blank with unknown semantics. */
export function modelFieldErrors(entry: ModelValidationFields): ModelFieldErrors {
  const errors: ModelFieldErrors = {};
  if (positiveInt(entry.contextWindow) === undefined) errors.contextWindow = '上下文上限未知，请填写后再保存';
  if (positiveInt(entry.maxTokens) === undefined) errors.maxTokens = '最大输出未知，请填写后再保存';
  if (!entry.grade) errors.grade = '请选择模型等级（快照不提供 grade，必须显式选择）';
  const price = costError(entry.cost);
  if (price) errors.cost = price;
  return errors;
}

export function hasRequiredModelFields(entry: ModelValidationFields): boolean {
  return Object.keys(modelFieldErrors(entry)).length === 0;
}

export interface MissingModelFields {
  index: number;
  id: string;
  fields: (keyof ModelFieldErrors)[];
}

/** Required-field problems for the whole document, so the autosave can block
 * with a named reason instead of sending a document the parser will reject. */
export function missingRequiredModelFields(entries: readonly ({ id?: string } & ModelValidationFields)[]): MissingModelFields[] {
  const problems: MissingModelFields[] = [];
  entries.forEach((entry, index) => {
    const errors = modelFieldErrors(entry);
    const fields = (['contextWindow', 'maxTokens', 'grade', 'cost'] as const).filter(field => errors[field]);
    if (fields.length) problems.push({ index, id: entry.id ?? `entries[${index}]`, fields: [...fields] });
  });
  return problems;
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
