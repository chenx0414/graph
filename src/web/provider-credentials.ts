import { PROVIDER_PRESETS } from '../catalog/providers.ts';

import {
MODEL_THINKING_LEVELS,
type ModelApi
} from '../catalog/models.ts';

export const CUSTOM_PLATFORM_ID = 'custom';

export const PROVIDER_ROUTES = {
  list: '/api/providers',
  probe: '/api/providers/probe',
} as const;

export const PROVIDER_COMPATIBILITIES: readonly { id: ModelApi; label: string }[] = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
];

export type CredentialKind = 'api-key' | 'subscription';

export interface PlatformPreset {
  id: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  credentialRef: string;
  credentialKind: CredentialKind;
  oauthProvider?: 'openrouter' | 'xai';
  modelsListSupported: boolean;
  custom?: boolean;
  credentialConfigured?: boolean;
  headers?: Record<string, string>;
  docsUrl?: string;
  notes?: string[];
}

export const FALLBACK_PLATFORMS: readonly PlatformPreset[] = PROVIDER_PRESETS.map(preset => ({
  ...preset,
  ...(preset.id === CUSTOM_PLATFORM_ID ? { custom: true, credentialConfigured: false } : {}),
}));

export const COMPATIBILITIES = new Set<string>(PROVIDER_COMPATIBILITIES.map(item => item.id));

export const THINKING = new Set<string>(MODEL_THINKING_LEVELS);

export const CREDENTIAL_ID = /^[a-z0-9][a-z0-9-_]*$/;

export const SECRET_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ProviderDraft {
  platformId: string;
  label: string;
  baseUrl: string;
  api: ModelApi;
  credentialId: string;
  credentialRef: string;
}

export type ProviderDraftField = 'label' | 'baseUrl' | 'api' | 'credentialId' | 'credentialRef' | 'key';

export type ProviderDraftErrors = Partial<Record<ProviderDraftField, string>>;

export interface ValidateProviderOptions {
  custom: boolean;
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

export function nextAccountDraft(platform: PlatformPreset, taken: readonly string[]): ProviderDraft {
  const draft = draftFromPlatform(platform);
  const used = new Set(taken);
  let index = 2;
  while (used.has(`${draft.credentialId}-${index}`)) index += 1;
  return { ...draft, credentialId: `${draft.credentialId}-${index}`, credentialRef: `${draft.credentialRef}_${index}` };
}

export interface AccountCredentialEntry {
  secretRef: string;
  displayName?: string;
  sharedLimitGroupId?: string;
  platform?: string;
}

export interface AccountCredentialInput {
  credentialId: string;
  credentialRef: string;
  label: string;
  platformId: string;
  custom: boolean;
}

export function accountCredentialEntry(previous: AccountCredentialEntry | undefined, input: AccountCredentialInput): AccountCredentialEntry {
  const entry: AccountCredentialEntry = {
    ...(previous ?? { secretRef: input.credentialRef }),
    secretRef: input.credentialRef,
    displayName: input.label || input.credentialId,
  };
  if (input.custom) delete entry.platform;
  else entry.platform = input.platformId;
  return entry;
}

export function customDraft(): ProviderDraft {
  return { platformId: CUSTOM_PLATFORM_ID, label: '', baseUrl: '', api: 'openai-completions', credentialId: 'custom', credentialRef: 'GRAPH_PROVIDER_API_KEY' };
}

export function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateProviderDraft(draft: ProviderDraft, options: ValidateProviderOptions): ProviderDraftErrors {
  const errors: ProviderDraftErrors = {};
  if (options.custom) {
    if (!draft.label.trim()) errors.label = '自定义厂商必须填写厂商名';
    if (!draft.baseUrl.trim()) errors.baseUrl = '自定义厂商必须填写 Base URL';
    else if (!validHttpUrl(draft.baseUrl.trim())) errors.baseUrl = 'Base URL 必须是 http(s) 绝对地址';
    if (!COMPATIBILITIES.has(draft.api)) errors.api = '兼容格式必须是 openai-completions、openai-responses 或 anthropic-messages';
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
  credentialRef: string;
}

export function selectionBlockedReason(input: CredentialResolution): string | null {
  if (input.resolved) return null;
  return `凭据未解析：请设置环境变量 ${input.credentialRef || '（对应环境变量名）'}，或在桌面端把密钥保存到钥匙串后再选择模型`;
}

export function concurrencyControlIds(credentialId: string): { credential: string; groupId: string; groupLimit: string } {
  return {
    credential: `limit-credential-${credentialId}`,
    groupId: `limit-group-id-${credentialId}`,
    groupLimit: `limit-group-${credentialId}`,
  };
}

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
      api: entry.api === 'anthropic-messages' ? 'anthropic-messages' : entry.api === 'openai-responses' ? 'openai-responses' : 'openai-completions',
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '',
      credentialRef,
      credentialKind: entry.credentialKind === 'subscription' ? 'subscription' : 'api-key',
      ...(entry.oauthProvider === 'xai' || entry.oauthProvider === 'openrouter' ? { oauthProvider: entry.oauthProvider } : {}),
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

export function draftFromPlatformWithCredential(
  platform: PlatformPreset,
  credentials: Record<string, { secretRef?: string; displayName?: string } | undefined> | undefined,
): ProviderDraft {
  return draftForCredential(platform, credentials, platform.id);
}

export function draftForCredential(
  platform: PlatformPreset,
  credentials: Record<string, { secretRef?: string; displayName?: string } | undefined> | undefined,
  credentialId: string,
): ProviderDraft {
  const draft = { ...draftFromPlatform(platform), credentialId };
  const stored = credentials?.[credentialId];
  const existing = stored?.secretRef?.trim();
  const label = stored?.displayName?.trim();
  return {
    ...draft,
    ...(label ? { label } : {}),
    ...(existing && existing !== draft.credentialRef ? { credentialRef: existing } : {}),
  };
}

export interface CredentialValueState {
  credentialState?: boolean | undefined;
  keyResolved?: boolean | undefined;
  platformConfigured?: boolean | undefined;
}

export function credentialResolved(resolution: CredentialValueState): boolean {
  const perCredential = resolution.credentialState;
  if (perCredential === false && !resolution.keyResolved) return false;
  if (perCredential === true || resolution.keyResolved) return true;
  return Boolean(resolution.platformConfigured);
}
