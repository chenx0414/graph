/**
 * Pure form logic for the two-step provider wizard (B-1 lane 3).
 *
 * The React component only renders and calls these helpers; nothing here reads
 * the DOM, keeps state or performs a request. That keeps the wizard's rules
 * (draft validation, probe merging, snapshot auto-fill and the inline
 * concurrency limits) testable in the sandbox.
 */
import type { ModelApi, ModelCost, ModelInput, ModelPricing, ModelThinkingLevel } from '../catalog/models.ts';

export const MODEL_APIS: readonly ModelApi[] = ['openai-completions', 'anthropic-messages'];
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type CredentialKind = 'api-key' | 'subscription';

/** One entry of the platform directory served by `GET /api/app/providers`. */
export interface PlatformOption {
  platformId: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  secretRef: string;
  configured: boolean;
  supportsModelList: boolean;
  defaultModel?: string;
  credentialLabel: string;
  credentialKind: CredentialKind;
  notes: string[];
  custom: boolean;
}

export function platformOption(platforms: readonly PlatformOption[], platformId: string): PlatformOption | undefined {
  return platforms.find(option => option.platformId === platformId);
}

/** Step 1 draft: the vendor itself, before any model is chosen. */
export interface ProviderFormDraft {
  platformId: string;
  name: string;
  api: ModelApi;
  baseUrl: string;
  secretRef: string;
}

export function draftFromPlatform(platform: PlatformOption): ProviderFormDraft {
  return { platformId: platform.platformId, name: platform.label, api: platform.api, baseUrl: platform.baseUrl, secretRef: platform.secretRef };
}

export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export interface DraftValidation {
  ok: boolean;
  errors: Record<string, string>;
  /** Normalized draft for the save/probe payload; only present when ok. */
  value?: ProviderFormDraft;
}

/**
 * Step 1 validation. A built-in platform only needs a credential ref; 自定义
 * additionally needs a vendor name, a Base URL and the compatibility mode.
 */
export function validateProviderFormDraft(draft: Partial<ProviderFormDraft>, platform?: PlatformOption): DraftValidation {
  const errors: Record<string, string> = {};
  const custom = !platform || platform.custom || draft.platformId === 'custom';
  const name = (draft.name ?? '').trim();
  const baseUrl = (draft.baseUrl ?? '').trim();
  const secretRef = (draft.secretRef ?? '').trim();

  if (!draft.platformId?.trim()) errors.platformId = '请选择厂商';
  if (!name) errors.name = '厂商名不能为空';
  if (!MODEL_APIS.includes(draft.api as ModelApi)) errors.api = '兼容格式必须是 OpenAI Chat Completions 或 Anthropic Messages';
  if (!baseUrl) errors.baseUrl = 'Base URL 不能为空';
  else if (!isHttpUrl(baseUrl)) errors.baseUrl = 'Base URL 必须是 http(s) 地址';
  if (!secretRef) errors.secretRef = custom ? '自定义厂商需要 API KEY' : '需要 API KEY 或订阅凭据';
  else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretRef)) errors.secretRef = '凭据引用必须是环境变量名';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    value: { platformId: draft.platformId!.trim(), name, api: draft.api as ModelApi, baseUrl, secretRef },
  };
}

/** Step 2 model draft. Numeric metadata stays optional so "unknown" is empty
 * rather than a zero that would later be read as a real limit or price. */
export interface ModelDraft {
  id: string;
  provider: string;
  modelId?: string;
  name?: string;
  grade: 'low' | 'medium' | 'high' | 'highest';
  api: ModelApi;
  baseUrl: string;
  credentialId: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
  reasoning?: boolean;
  thinkingLevels?: ModelThinkingLevel[];
  defaultThinkingLevel?: ModelThinkingLevel;
  cost?: ModelCost;
  pricing?: ModelPricing;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  /** Snapshot metadata attached by the server probe; null when unmatched. */
  metadata?: ModelMetadataLike | null;
}

/** Mirror of the server's models.dev mapping, kept local so the web bundle
 * never imports the 4.8 MB snapshot reader. */
export interface ModelMetadataLike {
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

/** One provider label is one registered transport: the config rejects two
 * credentials sharing a label with different endpoints, so a second connection
 * to the same platform gets a suffixed label instead. */
export function providerLabelFor(platformId: string, credentialId: string, entries: readonly { provider: string; credentialId: string }[]): string {
  const clash = entries.some(entry => entry.provider === platformId && entry.credentialId !== credentialId);
  return clash ? `${platformId}@${credentialId}` : platformId;
}

/** Local connection id: `<provider>:<upstream id>`, suffixed when taken. */
export function uniqueModelId(providerId: string, upstreamId: string, taken: readonly string[]): string {
  const base = `${providerId}:${upstreamId}`;
  let candidate = base;
  let suffix = 2;
  while (taken.includes(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

export function newModelDraft(base: { provider: string; api: ModelApi; baseUrl: string; credentialId: string; upstreamId: string; name?: string; taken: readonly string[] }): ModelDraft {
  return {
    id: uniqueModelId(base.provider, base.upstreamId, base.taken),
    provider: base.provider,
    modelId: base.upstreamId,
    ...(base.name ? { name: base.name } : {}),
    grade: 'medium',
    api: base.api,
    baseUrl: base.baseUrl,
    credentialId: base.credentialId,
  };
}

/**
 * Metadata auto-fill. Only fields that are still empty are written: a value the
 * user typed by hand (or a price/grading already set) is never overwritten.
 * A snapshot miss writes no numbers at all and marks the price unknown.
 */
export function metadataFill(metadata: ModelMetadataLike | null | undefined, options: { retrievedAt?: string } = {}): Partial<ModelDraft> {
  const cost = metadata?.cost;
  const pricing: ModelPricing = cost
    ? {
      currency: metadata?.currency ?? 'USD',
      unit: 'per_million_tokens',
      status: 'known',
      ...(metadata?.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
      ...(options.retrievedAt ? { retrievedAt: options.retrievedAt } : {}),
      ...(metadata?.catalogRevision ? { catalogRevision: metadata.catalogRevision } : {}),
    }
    : {
      // No usable amount: the price stays unknown and is never shown as zero.
      currency: metadata?.currency ?? 'USD',
      unit: 'per_million_tokens',
      status: 'unknown',
      ...(metadata?.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
    };
  return {
    ...(metadata?.contextWindow ? { contextWindow: metadata.contextWindow } : {}),
    ...(metadata?.maxTokens ? { maxTokens: metadata.maxTokens } : {}),
    ...(metadata?.input ? { input: metadata.input } : {}),
    ...(metadata?.reasoning !== undefined ? { reasoning: metadata.reasoning } : {}),
    ...(metadata?.thinkingLevels ? { thinkingLevels: metadata.thinkingLevels } : {}),
    ...(metadata?.defaultThinkingLevel ? { defaultThinkingLevel: metadata.defaultThinkingLevel } : {}),
    ...(cost ? { cost } : {}),
    pricing,
  };
}

export function applyMetadata(entry: ModelDraft, metadata: ModelMetadataLike | null | undefined, options: { retrievedAt?: string } = {}): ModelDraft {
  const fill = metadataFill(metadata, options);
  const next: ModelDraft = { ...entry };
  if (next.contextWindow === undefined && fill.contextWindow !== undefined) next.contextWindow = fill.contextWindow;
  if (next.maxTokens === undefined && fill.maxTokens !== undefined) next.maxTokens = fill.maxTokens;
  if (next.input === undefined && fill.input !== undefined) next.input = fill.input;
  if (next.reasoning === undefined && fill.reasoning !== undefined) next.reasoning = fill.reasoning;
  if (next.defaultThinkingLevel === undefined && fill.defaultThinkingLevel !== undefined) next.defaultThinkingLevel = fill.defaultThinkingLevel;
  if (fill.thinkingLevels !== undefined) next.thinkingLevels = fill.thinkingLevels;
  if (next.cost === undefined && fill.cost !== undefined) next.cost = fill.cost;
  if (next.pricing === undefined && fill.pricing !== undefined) next.pricing = fill.pricing;
  return next;
}

export interface ProbeModel {
  id: string;
  name?: string;
  metadata?: ModelMetadataLike | null;
}

/** Merge a probe result into the draft entries: existing rows keep every value
 * the user already set, only genuinely new models are appended. */
export function mergeDiscoveredModels(existing: ModelDraft[], discovered: readonly ProbeModel[], base: { provider: string; api: ModelApi; baseUrl: string; credentialId: string }, options: { retrievedAt?: string } = {}): ModelDraft[] {
  const known = new Map<string, ModelDraft>();
  for (const entry of existing) known.set(entry.modelId ?? entry.id, entry);
  const merged = [...existing];
  for (const model of discovered) {
    if (known.has(model.id)) continue;
    const created = applyMetadata(newModelDraft({
      provider: base.provider,
      api: base.api,
      baseUrl: base.baseUrl,
      credentialId: base.credentialId,
      upstreamId: model.id,
      ...(model.name ? { name: model.name } : {}),
      taken: merged.map(entry => entry.id),
    }), model.metadata, options);
    known.set(model.id, created);
    merged.push(created);
  }
  return merged;
}

/** Concurrency limits are edited inline on the vendor card: one cap per
 * credential plus an optional cross-credential shared group and its cap. */
export interface ConcurrencyDraft {
  credentialLimit?: number;
  sharedGroupId?: string;
  sharedGroupLimit?: number;
}

export interface LimitsDocument {
  credentials: Record<string, number>;
  sharedGroups: Record<string, number>;
}

export interface CredentialDocument {
  sharedLimitGroupId?: string;
}

export function readConcurrency(limits: LimitsDocument | undefined, credential: CredentialDocument | undefined, credentialId: string): ConcurrencyDraft {
  const credentialLimit = limits?.credentials?.[credentialId];
  const groupId = credential?.sharedLimitGroupId;
  const groupLimit = groupId ? limits?.sharedGroups?.[groupId] : undefined;
  return {
    ...(typeof credentialLimit === 'number' ? { credentialLimit } : {}),
    ...(groupId ? { sharedGroupId: groupId } : {}),
    ...(typeof groupLimit === 'number' ? { sharedGroupLimit: groupLimit } : {}),
  };
}

export interface ConcurrencyUpdate {
  limits: LimitsDocument;
  credential: CredentialDocument;
}

/** Write one vendor's inline limits back into the config draft. A cleared
 * number removes the entry (runtime default), an empty group removes the
 * credential's group; nothing touches other credentials. */
export function writeConcurrency(
  limits: LimitsDocument | undefined,
  credential: CredentialDocument | undefined,
  credentialId: string,
  draft: ConcurrencyDraft,
): ConcurrencyUpdate {
  const credentials = { ...(limits?.credentials ?? {}) };
  const sharedGroups = { ...(limits?.sharedGroups ?? {}) };
  const previousGroup = credential?.sharedLimitGroupId;
  const groupId = (draft.sharedGroupId ?? '').trim();

  if (typeof draft.credentialLimit === 'number' && Number.isFinite(draft.credentialLimit) && draft.credentialLimit > 0) credentials[credentialId] = Math.floor(draft.credentialLimit);
  else delete credentials[credentialId];

  // Leaving a group drops its cap; the group id lives on the credential, so
  // the two writes stay in step.
  if (previousGroup && previousGroup !== groupId) delete sharedGroups[previousGroup];
  if (groupId && typeof draft.sharedGroupLimit === 'number' && Number.isFinite(draft.sharedGroupLimit) && draft.sharedGroupLimit > 0) {
    sharedGroups[groupId] = Math.floor(draft.sharedGroupLimit);
  } else if (groupId && previousGroup !== groupId) {
    delete sharedGroups[groupId];
  }

  const nextCredential: CredentialDocument = { ...(credential ?? {}) };
  if (groupId) nextCredential.sharedLimitGroupId = groupId;
  else delete nextCredential.sharedLimitGroupId;
  return { limits: { credentials, sharedGroups }, credential: nextCredential };
}

/**
 * The vendor's platform id is persisted in the credential's free-form
 * `displayName` (no config schema change): a preset stores its id, 自定义
 * stores `custom:<name>`.
 */
export function encodeVendorRef(platformId: string, name: string): string {
  return platformId === 'custom' ? `custom:${name.trim() || 'custom'}` : platformId;
}

export function decodeVendorRef(displayName: string | undefined, knownPlatformIds: readonly string[]): { platformId: string; name: string } {
  const value = (displayName ?? '').trim();
  if (!value) return { platformId: 'custom', name: '' };
  if (value.startsWith('custom:')) return { platformId: 'custom', name: value.slice('custom:'.length) || 'custom' };
  if (knownPlatformIds.includes(value)) return { platformId: value, name: value };
  return { platformId: 'custom', name: value };
}
