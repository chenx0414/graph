/**
 * Console provider contract (B-1 lane 2).
 *
 * One place decides how a configured vendor is described and how its HTTP
 * requests are shaped. Everything that can be checked without a socket lives
 * here as a pure function, so the sandbox tests can assert request shapes and
 * vendor error text without any network:
 *
 * - `PLATFORM_PRESETS` is the built-in catalog of already-supported platforms;
 *   a platform entry names its default endpoint, transport and the environment
 *   variable / keychain ref that holds its credential. `custom` is the
 *   OpenAI/Anthropic-compatible escape hatch.
 * - `buildModelsRequest` / `buildVerifyRequest` build the model-list and the
 *   minimal chat request.
 * - `parseModelsResponse` / `parseVerifyResponse` keep the vendor's own error
 *   text verbatim; the console never rewrites it into a generic error.
 * - `sanitizeProviderView` produces the browser view. It only ever carries the
 *   `secretRef` and whether that ref resolves, never a secret value.
 */
import { RuntimeError, type Json } from '../core/types.ts';
import { modelRequestHeaders, type ModelApi } from '../catalog/models.ts';

export type PlatformCredentialKind = 'api-key' | 'subscription';

export interface PlatformCredentialRef {
  secretRef: string;
  label: string;
  kind: PlatformCredentialKind;
}

export interface PlatformPreset {
  id: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  credential: PlatformCredentialRef;
  /** Whether `<baseUrl>/models` is expected to answer; a false entry sends the
   * wizard straight to manual model ids instead of a doomed probe. */
  supportsModelList: boolean;
  /** Model used for the one-click verification when the caller has not chosen
   * one yet; absent means the model-list request is the verification request. */
  defaultModel?: string;
  docsUrl: string;
  notes: string[];
  custom: boolean;
}

/**
 * Already-supported platforms. The credential refs intentionally reuse the
 * `GRAPH_SUBSCRIPTION_*` names from `src/server/usage.ts`, so a key imported
 * for the usage page is the same key the model connection resolves.
 */
export const PLATFORM_PRESETS: readonly PlatformPreset[] = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    credential: { secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', label: 'OpenCode Go 订阅', kind: 'subscription' },
    supportsModelList: true,
    defaultModel: 'qwen3.7-max',
    docsUrl: 'https://opencode.ai/docs/zen',
    notes: ['订阅凭据可直接复用“用量”页导入的 OpenCode Go 密钥；请求带 x-opencode-session 路由头。'],
    custom: false,
  },
  {
    id: 'command-goat',
    label: 'Command Goat',
    api: 'openai-completions',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    credential: { secretRef: 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY', label: 'Command Goat 订阅', kind: 'subscription' },
    supportsModelList: true,
    defaultModel: 'deepseek/deepseek-v4-flash',
    docsUrl: 'https://commandcode.ai/docs',
    notes: ['CommandCode 订阅额度，使用 OpenAI 兼容传输。'],
    custom: false,
  },
  {
    id: 'grok',
    label: 'Grok',
    api: 'openai-completions',
    baseUrl: 'https://api.x.ai/v1',
    credential: { secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', label: 'xAI / SuperGrok 凭据', kind: 'subscription' },
    supportsModelList: true,
    defaultModel: 'grok-4.3',
    docsUrl: 'https://docs.x.ai/docs/api-reference',
    notes: ['xAI OpenAI 兼容端点；订阅凭据与“用量”页共用同一引用。'],
    custom: false,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    api: 'openai-completions',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    credential: { secretRef: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN', label: 'ChatGPT Codex 订阅', kind: 'subscription' },
    supportsModelList: false,
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    notes: ['Codex 订阅后端不提供 /models 列表，请在第二步手动添加模型 id。'],
    custom: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    credential: { secretRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY', label: 'DeepSeek API Key', kind: 'api-key' },
    supportsModelList: true,
    defaultModel: 'deepseek-v4-flash',
    docsUrl: 'https://api-docs.deepseek.com',
    notes: ['官方 OpenAI 兼容端点，填 API KEY 即可。'],
    custom: false,
  },
  {
    id: 'custom',
    label: '自定义',
    api: 'openai-completions',
    baseUrl: '',
    credential: { secretRef: 'GRAPH_CUSTOM_API_KEY', label: '自定义厂商凭据', kind: 'api-key' },
    supportsModelList: true,
    docsUrl: '',
    notes: ['自定义厂商需要填写厂商名、Base URL 与兼容格式（OpenAI Chat Completions 或 Anthropic Messages）。'],
    custom: true,
  },
];

export const PLATFORM_IDS: readonly string[] = PLATFORM_PRESETS.map(preset => preset.id);

export function platformPreset(id: string): PlatformPreset | undefined {
  return PLATFORM_PRESETS.find(preset => preset.id === id);
}

export function isCustomPlatform(id: string | undefined): boolean {
  return !id || id === 'custom';
}

/** One vendor draft: what the two-step wizard has gathered before saving. */
export interface ProviderDraft {
  platformId?: string;
  name?: string;
  api: ModelApi;
  baseUrl: string;
  /** Environment variable / keychain reference, never the secret value. */
  secretRef?: string;
  headers?: Record<string, string>;
}

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body?: Json;
}

export interface ProviderPreview {
  platformId: string;
  name: string;
  api: ModelApi;
  baseUrl: string;
  secretRef: string | null;
  configured: boolean;
  supportsModelList: boolean;
}

export function validateProviderDraft(draft: Partial<ProviderDraft> | undefined): ProviderDraft {
  const platformId = typeof draft?.platformId === 'string' && draft.platformId.trim() ? draft.platformId.trim() : 'custom';
  if (platformId !== 'custom' && !platformPreset(platformId)) {
    throw new RuntimeError('invalid_input', `Unknown platform "${platformId}"`);
  }
  if (draft?.api !== 'openai-completions' && draft?.api !== 'anthropic-messages') {
    throw new RuntimeError('invalid_input', 'api must be "openai-completions" or "anthropic-messages"');
  }
  const baseUrl = typeof draft.baseUrl === 'string' ? draft.baseUrl.trim() : '';
  if (!baseUrl) throw new RuntimeError('invalid_input', 'Base URL is required');
  const name = typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : platformPreset(platformId)?.label ?? 'custom';
  return {
    platformId,
    name,
    api: draft.api,
    baseUrl,
    ...(typeof draft.secretRef === 'string' && draft.secretRef.trim() ? { secretRef: draft.secretRef.trim() } : {}),
    ...(draft.headers && Object.keys(draft.headers).length ? { headers: draft.headers } : {}),
  };
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string) {
  return `${trimSlash(baseUrl)}/${path.replace(/^\/+/, '')}`;
}

/** Model list endpoint: OpenAI-compatible gateways answer `<baseUrl>/models`,
 * the Anthropic Messages transport answers `<baseUrl>/v1/models`. */
export function buildModelsUrl(api: ModelApi, baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (api === 'anthropic-messages') return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  return `${base}/models`;
}

/** Minimal chat endpoint for the one-click verification. */
export function buildChatUrl(api: ModelApi, baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (api === 'anthropic-messages') return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  return `${base}/chat/completions`;
}

function authHeaders(api: ModelApi, secret: string | undefined, platformId: string | undefined, baseUrl: string, headers: Record<string, string> | undefined): Record<string, string> {
  const routing = modelRequestHeaders({ provider: platformId ?? 'custom', baseUrl, ...(headers ? { headers } : {}) }) ?? {};
  if (api === 'anthropic-messages') {
    return {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(secret ? { 'x-api-key': secret } : {}),
      ...routing,
    };
  }
  return {
    'content-type': 'application/json',
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    ...routing,
  };
}

/** The model-list request. `secret` is the resolved credential value; it is
 * only ever placed in a header, never returned to the caller. */
export function buildModelsRequest(draft: ProviderDraft, secret?: string): HttpRequest {
  const provider = validateProviderDraft(draft);
  return {
    url: buildModelsUrl(provider.api, provider.baseUrl),
    headers: authHeaders(provider.api, secret?.trim() || undefined, provider.platformId, provider.baseUrl, provider.headers),
  };
}

/** The minimal chat request used to prove the credential and transport. */
export function buildVerifyRequest(draft: ProviderDraft, modelId: string, secret?: string): HttpRequest {
  const provider = validateProviderDraft(draft);
  const model = modelId.trim();
  if (!model) throw new RuntimeError('invalid_input', 'A model id is required to verify the provider');
  const body: Json = provider.api === 'anthropic-messages'
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    : { model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'ping' }] };
  return {
    url: buildChatUrl(provider.api, provider.baseUrl),
    headers: authHeaders(provider.api, secret?.trim() || undefined, provider.platformId, provider.baseUrl, provider.headers),
    body,
  };
}

/** The vendor's own error text, unwrapped but never rewritten. */
export function vendorErrorText(status: number, body: unknown): string {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const nested = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : undefined;
    const deeper = nested?.error && typeof nested.error === 'object' ? nested.error as Record<string, unknown> : undefined;
    for (const candidate of [nested?.message, deeper?.message, record.message, record.detail, typeof record.error === 'string' ? record.error : undefined]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    try {
      return JSON.stringify(body);
    } catch {
      return `HTTP ${status}`;
    }
  }
  return `HTTP ${status}`;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
}

export function parseModelsResponse(_provider: ProviderDraft, status: number, body: unknown): { models: DiscoveredModel[] } | { error: string } {
  if (status < 200 || status >= 300) return { error: vendorErrorText(status, body) };
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : undefined;
  const list = Array.isArray(body)
    ? body
    : Array.isArray(record?.data)
      ? record!.data as unknown[]
      : Array.isArray(record?.models)
        ? record!.models as unknown[]
        : undefined;
  if (!list) return { error: '模型列表响应中没有可识别的 data/models 数组' };
  const models: DiscoveredModel[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim()) models.push({ id: item.trim() });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) continue;
    const name = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim() : undefined;
    models.push({ id, ...(name ? { name } : {}) });
  }
  if (!models.length) return { error: '模型列表为空' };
  return { models };
}

export function parseVerifyResponse(status: number, body: unknown): { ok: true } | { ok: false; error: string } {
  if (status < 200 || status >= 300) return { ok: false, error: vendorErrorText(status, body) };
  return { ok: true };
}

/** Browser-safe view of one configured vendor: refs and resolution only. */
export function sanitizeProviderView(input: {
  platformId?: string;
  name?: string;
  api?: ModelApi;
  baseUrl?: string;
  secretRef?: string;
  configured?: boolean;
  credential?: { secretRef?: string; configured?: boolean; value?: string } | null;
}): ProviderPreview {
  const platformId = typeof input.platformId === 'string' && input.platformId ? input.platformId : 'custom';
  const secretRef = input.credential?.secretRef ?? input.secretRef ?? platformPreset(platformId)?.credential.secretRef ?? null;
  return {
    platformId,
    name: typeof input.name === 'string' && input.name ? input.name : platformPreset(platformId)?.label ?? platformId,
    api: input.api === 'anthropic-messages' ? 'anthropic-messages' : input.api === 'openai-completions' ? 'openai-completions' : platformPreset(platformId)?.api ?? 'openai-completions',
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : platformPreset(platformId)?.baseUrl ?? '',
    secretRef,
    configured: Boolean(input.credential?.configured ?? input.configured),
    supportsModelList: platformPreset(platformId)?.supportsModelList ?? true,
  };
}

export interface PlatformCatalogEntry extends ProviderPreview {
  label: string;
  credentialLabel: string;
  credentialKind: PlatformCredentialKind;
  supportsModelList: boolean;
  defaultModel?: string;
  docsUrl: string;
  notes: string[];
  custom: boolean;
}

/** The built-in platform directory as the wizard sees it: defaults plus
 * whether each platform's credential ref already resolves. */
export function platformCatalog(env: Record<string, string | undefined> = {}): PlatformCatalogEntry[] {
  return PLATFORM_PRESETS.map(preset => {
    const configured = Boolean(env[preset.credential.secretRef]?.trim());
    return {
      platformId: preset.id,
      name: preset.label,
      label: preset.label,
      api: preset.api,
      baseUrl: preset.baseUrl,
      secretRef: preset.credential.secretRef,
      configured,
      credentialLabel: preset.credential.label,
      credentialKind: preset.credential.kind,
      supportsModelList: preset.supportsModelList,
      ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
      docsUrl: preset.docsUrl,
      notes: [...preset.notes],
      custom: preset.custom,
    };
  });
}

/** Resolve the secret value for one draft from the daemon environment/keychain
 * import. Returns null when the ref is empty or nothing is stored under it. */
export function resolveProviderSecret(secretRef: string | undefined, env: Record<string, string | undefined>): string | null {
  const ref = typeof secretRef === 'string' ? secretRef.trim() : '';
  if (!ref) return null;
  const value = env[ref]?.trim();
  return value ? value : null;
}
