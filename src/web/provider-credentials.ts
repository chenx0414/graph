import { PROVIDER_PRESETS } from '../catalog/providers.ts';

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
MODEL_GRADES,
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
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
];

export type CredentialKind = 'api-key' | 'subscription';

export interface PlatformPreset {
  id: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  /** Environment variable / keychain entry name; config stores only this. */
  credentialRef: string;
  credentialKind: CredentialKind;
  oauthProvider?: 'openrouter';
  /** True when the vendor is known to expose `<baseUrl>/models`. Display-only:
   * a probe always attempts `/models` and lets the vendor's response decide. */
  modelsListSupported: boolean;
  custom?: boolean;
  /** Whether the daemon could already resolve this platform's credential. */
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

export const GRADES = new Set<string>(MODEL_GRADES);

export const THINKING = new Set<string>(MODEL_THINKING_LEVELS);

export const CREDENTIAL_ID = /^[a-z0-9][a-z0-9-_]*$/;

export const SECRET_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  // A custom provider is somebody's own gateway, not an account of a subscription platform.
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
      api: entry.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '',
      credentialRef,
      credentialKind: entry.credentialKind === 'subscription' ? 'subscription' : 'api-key',
      ...(entry.oauthProvider === 'openrouter' ? { oauthProvider: 'openrouter' as const } : {}),
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
  /** The daemon's per-credential answer: did the account's own variable resolve? */
  credentialState?: boolean | undefined;
  /** Whether the keychain holds a value for this account. */
  keyResolved?: boolean | undefined;
  /** The platform-wide flag, used only when the account has no answer of its own. */
  platformConfigured?: boolean | undefined;
}

export function credentialResolved(resolution: CredentialValueState): boolean {
  const perCredential = resolution.credentialState;
  if (perCredential === false && !resolution.keyResolved) return false;
  if (perCredential === true || resolution.keyResolved) return true;
  return Boolean(resolution.platformConfigured);
}
