import type { ModelApi } from '../catalog/models.ts';
import type { GraphConfig } from './config.ts';

/** Provider-credential category shown by the settings wizard: a plain API key
 * or a subscription access token. The wire value is always an environment
 * variable name (`secretRef`); the secret itself never enters this module. */
export type ProviderCredentialKind = 'api-key' | 'subscription';

/** One first-class provider Graph can configure with a single credential.
 * Presets carry the endpoint and transport defaults so the wizard only has to
 * collect a KEY (or subscription token), while `自定义` collects all fields. */
export interface PlatformPreset {
  id: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  /** Environment variable that holds the key; config stores only this name. */
  credentialRef: string;
  credentialKind: ProviderCredentialKind;
  /** Advisory only: hints whether the vendor is known to answer
   * `<baseUrl>/models`. It never gates the probe - a wrong local guess must
   * not hide a vendor that really does list models - so it only shapes copy.
   * False means "expect a manual model id", not "do not request". */
  modelsListSupported: boolean;
  /** Headers that must travel with every request (routing hints). */
  headers?: Record<string, string>;
  docsUrl?: string;
  notes: string[];
}

export const CUSTOM_PLATFORM_ID = 'custom';

/** Console provider endpoints. Deliberately registered on the session-cookie
 * `/api` face, NOT under `/api/app/*`: that prefix requires the desktop bridge
 * token the browser console cannot read, so probing would never reach the
 * daemon from the settings page. */
export const PROVIDER_ROUTES = {
  list: '/api/providers',
  probe: '/api/providers/probe',
} as const;

/** Built-in supported platforms. `custom` is the fallback for any other
 * OpenAI/Anthropic-compatible endpoint. Credential env names are shared with
 * the usage adapters (src/server/usage.ts) so one key configures both. */
export const PLATFORM_PRESETS: readonly PlatformPreset[] = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    credentialRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY',
    credentialKind: 'subscription',
    modelsListSupported: true,
    headers: { 'x-opencode-session': 'graph-console' },
    docsUrl: 'https://opencode.ai/docs/zen',
    notes: ['订阅凭据；<baseUrl>/models 实测可用，自动列出订阅侧模型；端点拒绝时按原始错误提示并允许手动添加模型 id。', '所有请求自动附带 x-opencode-session。'],
  },
  {
    id: 'command-goat',
    label: 'Command Goat',
    api: 'openai-completions',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    credentialRef: 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY',
    credentialKind: 'subscription',
    modelsListSupported: true,
    notes: ['订阅凭据；优先从 <baseUrl>/models 探测可用模型。'],
  },
  {
    id: 'grok',
    label: 'Grok',
    api: 'openai-completions',
    baseUrl: 'https://api.x.ai/v1',
    credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN',
    credentialKind: 'subscription',
    modelsListSupported: true,
    notes: ['订阅访问令牌；使用 xAI 的 OpenAI 兼容端点。'],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    api: 'openai-completions',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    credentialRef: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN',
    credentialKind: 'subscription',
    modelsListSupported: true,
    notes: ['ChatGPT/Codex 订阅访问令牌；后端以 Responses 形状返回，本轮按 Chat Completions 契约注册与探测，正式调用需在人工验收中确认。'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    credentialRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY',
    credentialKind: 'api-key',
    modelsListSupported: true,
    docsUrl: 'https://api-docs.deepseek.com/',
    notes: ['官方 API KEY；使用 OpenAI 兼容的 Chat Completions。'],
  },
  {
    id: CUSTOM_PLATFORM_ID,
    label: '自定义',
    api: 'openai-completions',
    baseUrl: '',
    credentialRef: 'GRAPH_PROVIDER_API_KEY',
    credentialKind: 'api-key',
    modelsListSupported: true,
    notes: ['自定义需提供 厂商名 + Base URL + 兼容格式（OpenAI Chat Completions / Anthropic Messages）+ API KEY。', '端点不支持模型列表时可手动添加模型 id。'],
  },
] as const;

export const PLATFORM_CREDENTIAL_REFS: Readonly<Record<string, string>> = Object.fromEntries(
  PLATFORM_PRESETS.map(preset => [preset.id, preset.credentialRef]),
);

export function platformPreset(id: string): PlatformPreset | undefined {
  return PLATFORM_PRESETS.find(preset => preset.id === id);
}

const SECRET_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Accept only string header maps (values are bounded, names token-safe). */
function sanitizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue !== 'string' || !headerValue) continue;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    headers[name] = headerValue;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A fully resolved provider draft: every field the probe and save paths need. */
export interface ResolvedProvider {
  id: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  /** Environment variable / keychain entry name; never the secret value. */
  credentialRef: string;
  credentialKind: ProviderCredentialKind;
  modelsListSupported: boolean;
  headers?: Record<string, string>;
  custom: boolean;
}

/** Provider draft as the settings page sends it in a probe/save request.
 * Field names are the shared contract: the display name is `label` and the
 * credential reference is `credentialRef` (never `name` / `secretRef`). */
export interface ProviderDraftBody {
  id?: string;
  label?: string;
  baseUrl?: string;
  api?: string;
  credentialRef?: string;
  headers?: Record<string, string>;
  modelsListSupported?: boolean;
}

export interface ProviderDraftError {
  field: string;
  message: string;
}

export type ProviderDraftValidation =
  | { ok: true; provider: ResolvedProvider }
  | { ok: false; errors: ProviderDraftError[] };

/** Validate a provider draft coming from the settings page. A supported
 * platform only needs a credential reference (label/baseUrl/api default from
 * the directory); `自定义` must supply label + baseUrl + compatibility api +
 * credentialRef itself. */
export function validateProviderDraft(input: unknown): ProviderDraftValidation {
  const draft = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const rawId = typeof draft.id === 'string' && draft.id.trim() ? draft.id.trim() : undefined;
  const preset = rawId ? platformPreset(rawId) : undefined;
  const custom = !preset || preset.id === CUSTOM_PLATFORM_ID;
  // The `custom` preset only carries UI hints; its required fields must come
  // from the draft so an explicit compatibility format is always chosen.
  const defaults = custom ? undefined : preset;
  const errors: ProviderDraftError[] = [];

  if (rawId && !preset && rawId !== CUSTOM_PLATFORM_ID) {
    errors.push({ field: 'id', message: `未知平台 "${rawId}"` });
  }

  const rawBaseUrl = typeof draft.baseUrl === 'string' ? draft.baseUrl.trim() : '';
  const baseUrl = rawBaseUrl || defaults?.baseUrl || '';
  if (!baseUrl) errors.push({ field: 'baseUrl', message: '自定义厂商必须填写 Base URL' });
  else if (!isHttpUrl(baseUrl)) errors.push({ field: 'baseUrl', message: 'Base URL 必须是 http(s) 绝对地址' });

  const rawApi = typeof draft.api === 'string' && draft.api.trim() ? draft.api.trim() : undefined;
  const api = rawApi ?? defaults?.api;
  if (api !== 'openai-completions' && api !== 'anthropic-messages') {
    errors.push({ field: 'api', message: '兼容格式必须是 openai-completions 或 anthropic-messages' });
  }

  const rawLabel = typeof draft.label === 'string' && draft.label.trim() ? draft.label.trim() : undefined;
  const label = rawLabel ?? defaults?.label ?? '';
  if (!label) errors.push({ field: 'label', message: '自定义厂商必须填写厂商名' });

  const rawCredentialRef = typeof draft.credentialRef === 'string' && draft.credentialRef.trim() ? draft.credentialRef.trim() : undefined;
  // Every provider still needs a credential ref; the directory supplies the
  // default name (the wizard may choose a distinct one per custom provider).
  const credentialRef = rawCredentialRef ?? preset?.credentialRef ?? '';
  if (!credentialRef) errors.push({ field: 'credentialRef', message: '需要凭据引用（环境变量名或钥匙串条目）' });
  else if (!SECRET_REF.test(credentialRef)) errors.push({ field: 'credentialRef', message: 'credentialRef 必须是环境变量名' });

  const headers = { ...(preset?.headers ?? {}), ...(sanitizeHeaders(draft.headers) ?? {}) };
  const modelsListSupported = typeof draft.modelsListSupported === 'boolean'
    ? draft.modelsListSupported
    : preset?.modelsListSupported ?? true;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    provider: {
      id: rawId ?? CUSTOM_PLATFORM_ID,
      label,
      api: api as ModelApi,
      baseUrl,
      credentialRef,
      credentialKind: preset?.credentialKind ?? 'api-key',
      modelsListSupported,
      ...(Object.keys(headers).length ? { headers } : {}),
      custom,
    },
  };
}

export interface ProbeRequest {
  requestId: string;
  provider: ResolvedProvider;
  modelId?: string;
  probeModels?: boolean;
}

/** Whether a probe should ask the vendor for its model list. The directory's
 * `modelsListSupported` flag is advisory copy only and must never gate the
 * request: only an explicit `probeModels:false` suppresses it. The vendor's
 * real response is the source of truth - a rejection surfaces its own error
 * text and the wizard can still add a model id by hand. */
export function shouldProbeModels(probeModels: boolean | undefined): boolean {
  return probeModels !== false;
}

export type ProbeRequestValidation =
  | { ok: true; request: ProbeRequest }
  | { ok: false; errors: ProviderDraftError[] };

/** Parse a probe body. `requestId` is the idempotency key the console POST
 * must always carry; the provider draft lives under `provider` (a flat body is
 * also accepted for convenience) and is validated by `validateProviderDraft`. */
export function validateProbeRequest(input: unknown): ProbeRequestValidation {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const errors: ProviderDraftError[] = [];
  const requestId = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim() : undefined;
  if (!requestId) errors.push({ field: 'requestId', message: 'requestId is required' });
  const validated = validateProviderDraft(body.provider ?? body);
  if (!validated.ok) errors.push(...validated.errors);
  if (errors.length || !requestId || !validated.ok) return { ok: false, errors };
  const modelId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : undefined;
  const probeModels = typeof body.probeModels === 'boolean' ? body.probeModels : undefined;
  return {
    ok: true,
    request: {
      requestId,
      provider: validated.provider,
      ...(modelId ? { modelId } : {}),
      ...(probeModels !== undefined ? { probeModels } : {}),
    },
  };
}

export interface ProbeTarget {
  baseUrl: string;
  api: ModelApi;
  /** Resolved secret value; present only inside the daemon during a probe. */
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface HttpRequestSpec {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

/** Auth headers per transport. Anthropic uses x-api-key + version; the
 * OpenAI-compatible transports use a bearer token. */
export function authHeaders(target: Pick<ProbeTarget, 'api' | 'apiKey'>): Record<string, string> {
  if (!target.apiKey) return {};
  if (target.api === 'anthropic-messages') return { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' };
  return { authorization: `Bearer ${target.apiKey}` };
}

/** Model-listing request for the provider (OpenAI-compatible `<base>/models`,
 * Anthropic-compatible `<base>/models`). Pure: builds the shape only. */
export function buildModelsRequest(target: ProbeTarget): HttpRequestSpec {
  return {
    method: 'GET',
    url: joinUrl(target.baseUrl, 'models'),
    headers: { accept: 'application/json', ...authHeaders(target), ...(target.headers ?? {}) },
  };
}

/** Minimal chat request used to prove a credential + model work. */
export function buildVerifyRequest(target: ProbeTarget, modelId: string): HttpRequestSpec {
  const anthropic = target.api === 'anthropic-messages';
  return {
    method: 'POST',
    url: joinUrl(target.baseUrl, anthropic ? 'messages' : 'chat/completions'),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...authHeaders(target),
      ...(target.headers ?? {}),
    },
    body: JSON.stringify(anthropic
      ? { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
      : { model: modelId, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'ping' }] }),
  };
}

export interface ProviderModelSummary {
  id: string;
  name?: string;
}

export type ModelsResponse = { models: ProviderModelSummary[] } | { error: string };

/** Extract the vendor's own error text. Never generalized: a JSON error body
 * contributes its message, a plain-text body is preserved verbatim. */
export function vendorErrorText(body: unknown, status: number): string {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed) {
      const parsed = tryJson(trimmed);
      if (parsed !== undefined && typeof parsed !== 'string') return vendorErrorText(parsed, status);
      return trimmed;
    }
  } else if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
    const nested = record.error;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
    for (const key of ['message', 'detail', 'msg', 'error_description']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    try {
      const raw = JSON.stringify(body);
      if (raw && raw !== '{}' && raw !== 'null') return raw;
    } catch {
      // fall through to the HTTP status
    }
  }
  return `HTTP ${status}`;
}

function tryJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readModelRow(row: unknown): ProviderModelSummary | null {
  if (typeof row === 'string' && row.trim()) return { id: row.trim() };
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const id = [record.id, record.model, record.slug, record.name]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  if (!id) return null;
  const name = [record.name, record.display_name, record.displayName]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  return { id: id.trim(), ...(name && name.trim() !== id.trim() ? { name: name.trim() } : {}) };
}

/** Parse `<base>/models`. Non-2xx always yields the vendor's original text. */
export function parseModelsResponse(_provider: ProbeTarget, status: number, body: unknown): ModelsResponse {
  if (status < 200 || status >= 300) return { error: vendorErrorText(body, status) };
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? (['data', 'models', 'items'] as const).map(key => (body as Record<string, unknown>)[key]).find(Array.isArray) as unknown[] | undefined ?? []
      : [];
  const models: ProviderModelSummary[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const model = readModelRow(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return { models };
}

export type VerifyResponse =
  | { ok: true; status: number }
  | { ok: false; status: number; error: string };

/** Parse the minimal chat response. Failures keep the vendor's raw wording. */
export function parseVerifyResponse(status: number, body: unknown): VerifyResponse {
  if (status >= 200 && status < 300) return { ok: true, status };
  return { ok: false, status, error: vendorErrorText(body, status) };
}

export interface ProviderCredentialView {
  secretRef: string;
  resolved: boolean;
  displayName?: string;
  sharedLimitGroupId?: string;
}

export interface ProviderView {
  credentials: Record<string, ProviderCredentialView>;
}

/** Credential view safe for the browser/API: names and resolved flags only,
 * never a secret value. `secretValues` is read inside the daemon and dropped. */
export function sanitizeProviderView(config: GraphConfig | null, secretValues: Record<string, string | undefined> = {}): ProviderView {
  const credentials: Record<string, ProviderCredentialView> = {};
  for (const [id, credential] of Object.entries(config?.credentials ?? {})) {
    credentials[id] = {
      secretRef: credential.secretRef,
      resolved: Boolean(secretValues[credential.secretRef]?.trim()),
      ...(credential.displayName ? { displayName: credential.displayName } : {}),
      ...(credential.sharedLimitGroupId ? { sharedLimitGroupId: credential.sharedLimitGroupId } : {}),
    };
  }
  return { credentials };
}

export interface PlatformView extends Omit<PlatformPreset, 'modelsListSupported'> {
  custom: boolean;
  modelsListSupported: boolean;
  credentialConfigured: boolean;
}

/** Platform directory for the settings wizard, with per-platform credential
 * resolution status derived from the daemon's merged secret view. */
export function platformCatalogView(secretValues: Record<string, string | undefined> = {}): { platforms: PlatformView[] } {
  return {
    platforms: PLATFORM_PRESETS.map(preset => ({
      ...preset,
      custom: preset.id === CUSTOM_PLATFORM_ID,
      credentialConfigured: Boolean(secretValues[preset.credentialRef]?.trim()),
    })),
  };
}
