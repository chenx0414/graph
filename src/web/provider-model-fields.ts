
/**
 * Pure logic for the two-step model-provider flow (B-1).
 *
 * Step 1 「配置厂商」 validates a provider draft, normalizes the platform
 * catalog served by `GET /api/providers` and edits the concurrency limits that
 * live *inside* a provider entry. Step 2 「选择模型」 merges the models probed
 * from `<baseUrl>/models` with the metadata mapped from the vendored models.dev
 * snapshot.
 *
 * The field names here mirror the daemon contract in `backend/internal/graph/server_providers.go`:
 * the display name is `label`, the credential reference is `credentialRef`
 * (never `name` / `secretRef`), and the probe body carries a `requestId`
 * idempotency key. This module stays presentational: it never reads the DOM,
 * never sends a request and never resolves an API key.
 */
import {
type ModelApi,
type ModelCost,
type ModelEntry,
type ModelGrade,
type ModelInput,
type ModelPricing,
type ModelThinkingLevel
} from '../catalog/models.ts';
import { GRADES,THINKING } from "./provider-credentials.ts";

export interface SnapshotMetadata {
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
  reasoning?: boolean;
  thinkingLevels?: string[];
  thinkingOptions?: { level: string; label: string }[];
  defaultThinkingLevel?: string;
  grade?: ModelGrade;
  cost?: ModelCost;
  currency?: string;
  sourceUrl?: string;
  catalogRevision?: string;
}

export function thinkingOptionsFromMetadata(metadata: SnapshotMetadata | null | undefined): { level: ModelThinkingLevel; label: string }[] {
  const levels = thinkingLevels(metadata?.thinkingLevels).filter(level => level !== 'off');
  if (!metadata?.thinkingLevels?.length) return (['minimal', 'low', 'medium', 'high'] as ModelThinkingLevel[]).map(level => ({ level, label: level }));
  const labels = new Map(metadata?.thinkingOptions?.map(option => [option.level, option.label]) ?? []);
  return levels.map(level => ({ level, label: labels.get(level) ?? level }));
}

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

export const UNKNOWN_PRICING: ModelPricing = { currency: '', unit: 'per_million_tokens', status: 'unknown' };

export function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function finiteCost(cost: ModelCost | undefined): ModelCost | null {
  if (!cost) return null;
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (typeof cost[field] !== 'number' || !Number.isFinite(cost[field]) || cost[field] < 0) return null;
  }
  return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
}

export function thinkingLevels(values: readonly string[] | undefined): ModelThinkingLevel[] {
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

export interface ModelCostDraft {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const MODEL_COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

export function finitePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function costError(cost?: ModelCostDraft | null): string | null {
  if (!cost) return null;
  const present = MODEL_COST_FIELDS.filter(field => cost[field] !== undefined);
  if (!present.length) return null;
  if (present.length < MODEL_COST_FIELDS.length) return '价格需要成套填写（输入/输出/缓存读/缓存写）；缺失项不会按 0 计算';
  return MODEL_COST_FIELDS.every(field => finitePrice(cost[field]))
    ? null
    : '价格需要成套填写（输入/输出/缓存读/缓存写）；缺失项不会按 0 计算';
}

export function completeCost(cost?: ModelCostDraft | null): ModelCost | null {
  if (!cost) return null;
  if (!MODEL_COST_FIELDS.every(field => finitePrice(cost[field]))) return null;
  return { input: cost.input!, output: cost.output!, cacheRead: cost.cacheRead!, cacheWrite: cost.cacheWrite! };
}

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

export type PersistedModelEntry = Omit<ModelEntry, 'contextWindow' | 'maxTokens' | 'credentialId' | 'grade'> & {
  contextWindow?: number;
  maxTokens?: number;
  credentialId: string;
  grade?: ModelGrade;
};

export function draftToModelEntry(draft: ModelEntryDraft): PersistedModelEntry {
  const cost = completeCost(draft.cost);
  const pricing = cost
    ? (draft.pricing && draft.pricing.status !== 'unknown'
        ? draft.pricing
        : { currency: draft.pricing?.currency || 'USD', unit: 'per_million_tokens' as const, status: 'known' as const, sourceUrl: 'manual' })
    : (draft.pricing && draft.pricing.currency.trim() ? draft.pricing : undefined);
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

export function uniqueLocalModelId(providerId: string, modelId: string, taken: readonly string[]): string {
  const base = `${providerId}:${modelId}`;
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export function positiveInt(value: unknown): number | undefined {
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
