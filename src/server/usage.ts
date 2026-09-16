import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GraphConfig } from './config.ts';

export type UsageProviderId = 'opencode-go' | 'command-goat' | 'deepseek' | 'grok' | 'chatgpt';
export type UsageStatus = 'ok' | 'warning' | 'limited' | 'unconfigured' | 'error';

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: number | null;
  used?: number;
  limit?: number;
  unit?: string;
}

export interface UsageBalance {
  remaining?: number;
  used?: number;
  total?: number;
  currency?: string;
  unit?: string;
}

export interface UsagePlan {
  id: UsageProviderId;
  name: string;
  subtitle: string;
  configured: boolean;
  status: UsageStatus;
  plan: string | null;
  credentialSource: string | null;
  windows: UsageWindow[];
  balance: UsageBalance | null;
  details: Record<string, string | number | null>;
  error: string | null;
  updatedAt: number;
}

export interface ModelPrice {
  modelId: string;
  displayName: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion: number;
  cacheCreationCostPerMillion: number;
}

export interface UsageSnapshot {
  generatedAt: number;
  plans: UsagePlan[];
  pricing: {
    source: string;
    updatedAt: number | null;
    models: ModelPrice[];
  };
  summary: {
    configured: number;
    connected: number;
    warnings: number;
    limited: number;
    unconfigured: number;
  };
}

export interface UsageService {
  get(force?: boolean): Promise<UsageSnapshot>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Credential = { value: string; source: string };
type LoadConfig = () => Promise<{ config: GraphConfig; env: Record<string, string | undefined> }>;

interface UsageServiceOptions {
  loadConfig?: LoadConfig | undefined;
  env?: Record<string, string | undefined> | undefined;
  home?: string | undefined;
  fetch?: FetchLike | undefined;
  pricingPath?: string | undefined;
  cacheTtlMs?: number | undefined;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const COMMAND_CODE_BASE = 'https://api.commandcode.ai';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const GROK_BILLING_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';

const PLAN_BLUEPRINTS: Record<UsageProviderId, { name: string; subtitle: string }> = {
  'opencode-go': { name: 'OpenCode Go', subtitle: 'openCode.ai · 5 小时滚动额度' },
  'command-goat': { name: 'Command Goat', subtitle: 'CommandCode · 月度订阅额度' },
  deepseek: { name: 'DeepSeek', subtitle: 'DeepSeek 官方 API · 账户余额' },
  grok: { name: 'Grok', subtitle: 'xAI SuperGrok · 周期额度' },
  chatgpt: { name: 'ChatGPT', subtitle: 'ChatGPT Codex · 官方订阅额度' },
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function boolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseDate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function basePlan(id: UsageProviderId, configured = false, status: UsageStatus = 'unconfigured'): UsagePlan {
  const blueprint = PLAN_BLUEPRINTS[id];
  return {
    id,
    name: blueprint.name,
    subtitle: blueprint.subtitle,
    configured,
    status,
    plan: null,
    credentialSource: null,
    windows: [],
    balance: null,
    details: {},
    error: null,
    updatedAt: Date.now(),
  };
}

function statusFor(windows: UsageWindow[]): UsageStatus {
  const maxUsed = windows.reduce((max, window) => Math.max(max, window.usedPercent), 0);
  if (maxUsed >= 100) return 'limited';
  if (maxUsed >= 80) return 'warning';
  return 'ok';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function readJson(path: string): Promise<unknown | null> {
  const value = await readText(path);
  if (value === null) return null;
  return JSON.parse(value) as unknown;
}

function selectedCredential(env: Record<string, string | undefined>, names: string[]): Credential | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { value, source: `环境变量 ${name}` };
  }
  return null;
}

function configCredential(config: GraphConfig | null, env: Record<string, string | undefined>, match: (entry: NonNullable<GraphConfig['models']>['entries'][number]) => boolean): Credential | null {
  if (!config?.models) return null;
  for (const entry of config.models.entries) {
    if (!match(entry)) continue;
    const credential = config.credentials[entry.credentialId];
    const value = credential ? env[credential.secretRef]?.trim() : '';
    if (value) return { value, source: `Graph 模型 · ${entry.provider}` };
  }
  return null;
}

function literalCredential(value: unknown, source: string): Credential | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.includes('${') || normalized.startsWith('env:') || normalized.includes('{env:')) return null;
  return { value: normalized, source };
}

function openCodeProviderCredential(config: unknown, ids: string[], baseHint: string): Credential | null {
  const providers = record(record(config)?.provider);
  if (!providers) return null;
  for (const [id, raw] of Object.entries(providers)) {
    const provider = record(raw);
    const options = record(provider?.options);
    const baseUrl = text(options?.baseURL) ?? '';
    if (!ids.includes(id.toLowerCase()) && !baseUrl.toLowerCase().includes(baseHint)) continue;
    const credential = literalCredential(options?.apiKey, `OpenCode 配置 · ${id}`);
    if (credential) return credential;
  }
  return null;
}

function firstCredential(...values: (Credential | null)[]): Credential | null {
  return values.find((value): value is Credential => Boolean(value)) ?? null;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  try {
    const parsed = JSON.parse(raw) as unknown;
    const body = record(parsed);
    if (!body) throw new Error('响应不是 JSON 对象');
    return body;
  } catch (error) {
    if (error instanceof Error && error.message === '响应不是 JSON 对象') throw error;
    throw new Error(`${label} 响应解析失败`);
  }
}

function percentWindow(id: string, label: string, used: number, resetAt: number | null, details: { used?: number; limit?: number; unit?: string } = {}): UsageWindow {
  const normalized = clampPercent(used);
  return {
    id,
    label,
    usedPercent: normalized,
    remainingPercent: clampPercent(100 - normalized),
    resetAt,
    ...(details.used !== undefined ? { used: details.used } : {}),
    ...(details.limit !== undefined ? { limit: details.limit } : {}),
    ...(details.unit ? { unit: details.unit } : {}),
  };
}

function openCodeWindows(body: Record<string, unknown>, now: number): UsageWindow[] {
  const usage = record(body.usage);
  if (!usage) return [];
  const windows: UsageWindow[] = [];
  const entries: [string, string][] = [['rolling', '5 小时'], ['weekly', '本周'], ['monthly', '本月']];
  for (const [id, label] of entries) {
    const raw = record(usage[id]);
    if (!raw) continue;
    const percent = number(raw.percent);
    if (percent === null) continue;
    const resetAt = percent > 0 ? parseDate(raw.resetsAt) : null;
    windows.push(percentWindow(id, label, percent, resetAt));
  }
  // The legacy HTML/DOM endpoint used rollingUsage, weeklyUsage and
  // monthlyUsage. Keep this fallback so a dashboard format rollback does not
  // make the card empty.
  if (!windows.length) {
    for (const [key, id, label] of [['rollingUsage', 'rolling', '5 小时'], ['weeklyUsage', 'weekly', '本周'], ['monthlyUsage', 'monthly', '本月']] as const) {
      const raw = record(usage[key]);
      if (!raw) continue;
      const percent = number(raw.usagePercent);
      if (percent === null) continue;
      const resetSeconds = number(raw.resetInSec);
      windows.push(percentWindow(id, label, percent, resetSeconds === null ? null : now + resetSeconds * 1000));
    }
  }
  return windows;
}

async function fetchOpenCode(
  config: GraphConfig | null,
  env: Record<string, string | undefined>,
  openCodeConfig: unknown,
  fetchImpl: FetchLike,
  now: number,
): Promise<UsagePlan> {
  const credential = firstCredential(
    selectedCredential(env, ['OPENCODE_GO_API_KEY', 'OPENCODE_ZEN_API_KEY', 'OPENCODE_API_KEY']),
    configCredential(config, env, entry => entry.baseUrl.includes('opencode.ai/zen/go') || entry.provider.toLowerCase().includes('opencode-go')),
    openCodeProviderCredential(openCodeConfig, ['opencode-go'], 'opencode.ai/zen/go'),
  );
  if (!credential) return basePlan('opencode-go');
  const response = await fetchWithTimeout(fetchImpl, OPENCODE_USAGE_URL, {
    headers: { authorization: `Bearer ${credential.value}`, accept: 'application/json' },
  });
  if (response.status === 403) throw new Error('API Key 有效，但当前账号没有 OpenCode Go 订阅');
  const body = await responseJson(response, 'OpenCode Go 用量');
  const windows = openCodeWindows(body, now);
  if (!windows.length) throw new Error('用量响应中没有可识别的配额窗口');
  return {
    ...basePlan('opencode-go', true, statusFor(windows)),
    plan: 'Go',
    credentialSource: credential.source,
    windows,
  };
}

const COMMAND_PLAN_QUOTA: Record<string, number> = {
  'individual-go': 10,
  'individual-goat': 70,
  'individual-pro': 80,
  'individual-max': 150,
  'individual-ultra': 300,
};

const COMMAND_PLAN_NAME: Record<string, string> = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
};

function commandWindow(id: string, label: string, raw: Record<string, unknown> | null, now: number): UsageWindow | null {
  if (!raw) return null;
  const used = number(raw.used);
  const cap = number(raw.cap);
  if (used === null || cap === null || cap <= 0) return null;
  const reset = number(raw.resetAt);
  return percentWindow(id, label, (used / cap) * 100, reset === null ? null : reset, { used, limit: cap, unit: 'USD' });
}

async function fetchCommandGoat(
  config: GraphConfig | null,
  env: Record<string, string | undefined>,
  openCodeConfig: unknown,
  fetchImpl: FetchLike,
  now: number,
): Promise<UsagePlan> {
  const credential = firstCredential(
    selectedCredential(env, ['COMMANDCODE_API_KEY', 'COMMAND_GOAT_API_KEY', 'COMMANDCODE_GO_API_KEY']),
    configCredential(config, env, entry => entry.baseUrl.includes('api.commandcode.ai') || entry.provider.toLowerCase().includes('command')),
    openCodeProviderCredential(openCodeConfig, ['command-goat', 'commandcode'], 'api.commandcode.ai'),
  );
  if (!credential) return basePlan('command-goat');
  const headers = { authorization: `Bearer ${credential.value}`, accept: 'application/json' };
  const [creditsResponse, subscriptionResponse] = await Promise.all([
    fetchWithTimeout(fetchImpl, `${COMMAND_CODE_BASE}/alpha/billing/credits`, { headers }),
    fetchWithTimeout(fetchImpl, `${COMMAND_CODE_BASE}/alpha/billing/subscriptions`, { headers }),
  ]);
  const creditsBody = await responseJson(creditsResponse, 'Command Goat 余额');
  const credits = record(creditsBody.credits);
  if (!credits) throw new Error('余额响应缺少 credits');
  const subscriptionBody = subscriptionResponse.ok ? await responseJson(subscriptionResponse, 'Command Goat 订阅').catch(() => null) : null;
  const subscription = record(subscriptionBody?.data);
  const planId = text(subscription?.planId);
  const monthlyRemaining = number(credits.monthlyCredits) ?? 0;
  const monthlyTotal = planId ? COMMAND_PLAN_QUOTA[planId.toLowerCase()] ?? null : null;
  const monthlyUsed = monthlyTotal === null ? null : Math.max(0, monthlyTotal - monthlyRemaining);
  const limits = record(creditsBody.windowLimits);
  const limited = boolean(limits?.limited) ?? false;
  const windows = limited ? [
    commandWindow('five_hour', '5 小时', record(limits?.fiveHour), now),
    commandWindow('weekly', '本周', record(limits?.weekly), now),
    monthlyTotal !== null && monthlyUsed !== null
      ? percentWindow('monthly', '本月', (monthlyUsed / monthlyTotal) * 100, parseDate(subscription?.currentPeriodEnd), { used: monthlyUsed, limit: monthlyTotal, unit: 'USD' })
      : null,
  ].filter((window): window is UsageWindow => Boolean(window)) : monthlyTotal !== null && monthlyUsed !== null
    ? [percentWindow('monthly', '本月', (monthlyUsed / monthlyTotal) * 100, parseDate(subscription?.currentPeriodEnd), { used: monthlyUsed, limit: monthlyTotal, unit: 'USD' })]
    : [];
  return {
    ...basePlan('command-goat', true, statusFor(windows)),
    plan: planId ? COMMAND_PLAN_NAME[planId.toLowerCase()] ?? planId : 'Coding Plan',
    credentialSource: credential.source,
    windows,
    balance: {
      remaining: monthlyRemaining,
      ...(monthlyUsed !== null ? { used: monthlyUsed } : {}),
      ...(monthlyTotal !== null ? { total: monthlyTotal } : {}),
      currency: 'USD',
      unit: '$',
    },
    details: {
      已购额度: number(credits.purchasedCredits),
      赠送额度: number(credits.freeCredits),
      月度剩余: monthlyRemaining,
    },
  };
}

async function fetchDeepSeek(
  config: GraphConfig | null,
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
): Promise<UsagePlan> {
  const credential = firstCredential(
    selectedCredential(env, ['DEEPSEEK_API_KEY']),
    configCredential(config, env, entry => entry.baseUrl.includes('api.deepseek.com') || entry.provider.toLowerCase().includes('deepseek')),
  );
  if (!credential) return basePlan('deepseek');
  const response = await fetchWithTimeout(fetchImpl, DEEPSEEK_BALANCE_URL, {
    headers: { authorization: `Bearer ${credential.value}`, accept: 'application/json' },
  });
  const body = await responseJson(response, 'DeepSeek 余额');
  const infos = array(body.balance_infos).map(record).filter((value): value is Record<string, unknown> => Boolean(value));
  const info = infos.find(value => text(value.currency)?.toUpperCase() === 'CNY')
    ?? infos.find(value => number(value.total_balance) !== null)
    ?? infos[0]
    ?? null;
  const remaining = number(info?.total_balance) ?? 0;
  const currency = text(info?.currency) ?? 'CNY';
  const available = boolean(body.is_available) ?? true;
  return {
    ...basePlan('deepseek', true, available ? 'ok' : 'limited'),
    plan: 'API 余额',
    credentialSource: credential.source,
    balance: { remaining, currency, unit: currency === 'CNY' ? '¥' : '$' },
    details: {
      可用状态: available ? '可用' : '余额不足',
      赠送余额: number(info?.granted_balance),
      充值余额: number(info?.topped_up_balance),
    },
  };
}

interface CodexAuth {
  accessToken: string;
  accountId: string | null;
  planHint: string | null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return record(JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')));
  } catch {
    return null;
  }
}

function jwtAccountId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const auth = record(payload?.['https://api.openai.com/auth']);
  const organizations = array(payload?.organizations).map(record).filter((value): value is Record<string, unknown> => Boolean(value));
  return text(payload?.chatgpt_account_id) ?? text(auth?.chatgpt_account_id) ?? text(organizations[0]?.id);
}

async function codexAuth(home: string, env: Record<string, string | undefined>): Promise<CodexAuth | null> {
  const envToken = selectedCredential(env, ['GRAPH_CHATGPT_ACCESS_TOKEN', 'CHATGPT_ACCESS_TOKEN']);
  if (envToken) return { accessToken: envToken.value, accountId: text(env.GRAPH_CHATGPT_ACCOUNT_ID), planHint: envToken.source };
  const path = env.GRAPH_CODEX_AUTH_PATH?.trim() || join(home, '.codex', 'auth.json');
  const raw = await readJson(path);
  if (raw === null) return null;
  const root = record(raw);
  const tokens = record(root?.tokens);
  const accessToken = text(tokens?.access_token);
  if (!root || !accessToken) throw new Error('Codex auth.json 缺少 tokens.access_token');
  return {
    accessToken,
    accountId: text(tokens?.account_id) ?? jwtAccountId(accessToken),
    planHint: 'Codex CLI 登录',
  };
}

function chatGptLabel(seconds: number | null): string {
  if (seconds === null) return '用量窗口';
  if (seconds <= 6 * 3600) return '5 小时';
  if (seconds <= 8 * 86400) return '本周';
  if (seconds <= 32 * 86400) return '本月';
  return `${Math.max(1, Math.round(seconds / 86400))} 天`;
}

function codexWindows(body: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const append = (rateLimit: unknown, prefix: string) => {
    const limit = record(rateLimit);
    if (!limit) return;
    for (const [index, key] of ['primary_window', 'secondary_window'].entries()) {
      const raw = record(limit[key]);
      if (!raw) continue;
      const percent = number(raw.used_percent);
      if (percent === null) continue;
      const seconds = number(raw.limit_window_seconds);
      windows.push(percentWindow(`${prefix}-${index}`, chatGptLabel(seconds), percent, parseDate(raw.reset_at)));
    }
  };
  append(body.rate_limit, 'codex');
  for (const [index, raw] of array(body.additional_rate_limits).entries()) {
    const item = record(raw);
    append(item?.rate_limit, `additional-${index}`);
  }
  return windows;
}

async function fetchChatGpt(home: string, env: Record<string, string | undefined>, fetchImpl: FetchLike): Promise<UsagePlan> {
  const auth = await codexAuth(home, env);
  if (!auth) return basePlan('chatgpt');
  const response = await fetchWithTimeout(fetchImpl, CHATGPT_USAGE_URL, {
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      accept: 'application/json',
      'user-agent': 'codex-cli',
      ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
    },
  });
  if (response.status === 401 || response.status === 403) throw new Error('ChatGPT 登录凭据已过期，请重新登录 Codex');
  const body = await responseJson(response, 'ChatGPT 用量');
  const windows = codexWindows(body);
  if (!windows.length) throw new Error('用量响应中没有可识别的配额窗口');
  const credits = record(body.credits);
  const creditBalance = number(credits?.balance);
  return {
    ...basePlan('chatgpt', true, statusFor(windows)),
    plan: text(body.plan_type) ?? 'ChatGPT',
    credentialSource: auth.planHint,
    windows,
    ...(creditBalance !== null ? { balance: { remaining: creditBalance, currency: 'USD', unit: '$' } } : {}),
  };
}

interface GrokAuth {
  accessToken: string;
  source: string;
}

async function grokAuth(home: string, env: Record<string, string | undefined>): Promise<GrokAuth | null> {
  const envToken = selectedCredential(env, ['GRAPH_GROK_ACCESS_TOKEN', 'GROK_ACCESS_TOKEN']);
  if (envToken) return { accessToken: envToken.value, source: envToken.source };
  const path = env.GRAPH_GROK_AUTH_PATH?.trim() || join(home, '.grok', 'auth.json');
  const raw = await readJson(path);
  if (raw === null) return null;
  const root = record(raw);
  if (!root) throw new Error('Grok auth.json 根节点不是对象');
  const entries = Object.entries(root)
    .map(([scope, value]) => ({ scope, value: record(value) }))
    .filter((entry): entry is { scope: string; value: Record<string, unknown> } => Boolean(entry.value));
  const selected = entries.find(entry => entry.scope.startsWith('https://auth.x.ai::') && text(entry.value.key))
    ?? entries.find(entry => entry.scope.includes('/sign-in') && text(entry.value.key));
  const accessToken = text(selected?.value.key);
  if (!accessToken) throw new Error('Grok auth.json 中没有可用的 access token');
  return { accessToken, source: 'Grok CLI 登录' };
}

interface ProtoScan {
  fixed32: { path: number[]; value: number; order: number }[];
  varint: { path: number[]; value: number }[];
}

function readVarint(bytes: Uint8Array, cursor: { index: number }): number | null {
  let value = 0;
  let shift = 0;
  while (cursor.index < bytes.length && shift < 64) {
    const byte = bytes[cursor.index++]!;
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  return null;
}

function scanProtobuf(bytes: Uint8Array, depth: number, path: number[], order: { value: number }, scan: ProtoScan): void {
  const cursor = { index: 0 };
  while (cursor.index < bytes.length) {
    const fieldStart = cursor.index;
    const key = readVarint(bytes, cursor);
    if (!key) {
      cursor.index = fieldStart + 1;
      continue;
    }
    const fieldNumber = Math.floor(key / 8);
    const wireType = key & 7;
    const fieldPath = [...path, fieldNumber];
    if (wireType === 0) {
      const value = readVarint(bytes, cursor);
      if (value === null) cursor.index = fieldStart + 1;
      else scan.varint.push({ path: fieldPath, value });
    } else if (wireType === 1) {
      cursor.index += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, cursor);
      if (length === null || length < 0 || cursor.index + length > bytes.length) {
        cursor.index = fieldStart + 1;
        continue;
      }
      if (depth < 4) scanProtobuf(bytes.slice(cursor.index, cursor.index + length), depth + 1, fieldPath, order, scan);
      cursor.index += length;
    } else if (wireType === 5) {
      if (cursor.index + 4 > bytes.length) return;
      const value = new DataView(bytes.buffer, bytes.byteOffset + cursor.index, 4).getFloat32(0, true);
      scan.fixed32.push({ path: fieldPath, value, order: order.value++ });
      cursor.index += 4;
    } else {
      cursor.index = fieldStart + 1;
    }
  }
}

function grpcFrames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const cursor = { index: 0 };
  while (cursor.index < bytes.length) {
    if (cursor.index + 5 > bytes.length) return [];
    const flags = bytes[cursor.index]!;
    const length = new DataView(bytes.buffer, bytes.byteOffset + cursor.index + 1, 4).getUint32(0);
    const start = cursor.index + 5;
    const end = start + length;
    if (end > bytes.length) return [];
    if ((flags & 0x80) === 0) frames.push(bytes.slice(start, end));
    cursor.index = end;
  }
  return frames;
}

function parseGrokBilling(bytes: Uint8Array, now: number): { usedPercent: number; resetAt: number | null } {
  let payloads = grpcFrames(bytes);
  if (!payloads.length && bytes.length && ((bytes[0]! >> 3) > 0) && [0, 1, 2, 5].includes(bytes[0]! & 7)) payloads = [bytes];
  if (!payloads.length) throw new Error('Grok 账单响应没有可解析的 protobuf 数据');
  const scan: ProtoScan = { fixed32: [], varint: [] };
  const order = { value: 0 };
  for (const payload of payloads) scanProtobuf(payload, 0, [], order, scan);
  const percent = scan.fixed32
    .filter(field => field.path.at(-1) === 1 && Number.isFinite(field.value) && field.value >= 0 && field.value <= 100)
    .sort((left, right) => left.path.length - right.path.length || left.order - right.order)[0]?.value;
  const resetCandidates = scan.varint
    .filter(field => field.value >= 1_700_000_000 && field.value <= 2_100_000_000 && field.value * 1000 > now)
    .map(field => ({ path: field.path, ts: field.value * 1000 }));
  const resetAt = resetCandidates.find(field => field.path.join('.') === '1.5.1')?.ts
    ?? resetCandidates.sort((left, right) => left.ts - right.ts)[0]?.ts
    ?? null;
  const hasPeriod = scan.varint.some(field => field.path[0] === 1 && field.path[1] === 6)
    || scan.varint.some(field => field.path.join('.') === '1.8.1' && (field.value === 1 || field.value === 2));
  if (percent === undefined && !(resetAt && hasPeriod && scan.fixed32.length === 0)) throw new Error('Grok 账单响应中未找到用量百分比');
  return { usedPercent: percent ?? 0, resetAt };
}

function grokWindowLabel(resetAt: number | null, now: number): string {
  if (resetAt === null) return '额度';
  const days = Math.round((resetAt - now) / 86_400_000);
  if (days >= 4 && days <= 12) return '本周';
  if (days >= 20 && days <= 45) return '本月';
  return '额度';
}

async function fetchGrok(home: string, env: Record<string, string | undefined>, fetchImpl: FetchLike, now: number): Promise<UsagePlan> {
  const auth = await grokAuth(home, env);
  if (!auth) return basePlan('grok');
  const response = await fetchWithTimeout(fetchImpl, GROK_BILLING_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      origin: 'https://grok.com',
      referer: 'https://grok.com/?_s=usage',
      accept: '*/*',
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1',
      'user-agent': 'Graph',
    },
    body: new Uint8Array([0, 0, 0, 0, 0]),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Grok 登录凭据已过期，请重新执行 grok login');
  if (response.status === 408) throw new Error('Grok 账单服务暂时超时');
  if (!response.ok) throw new Error(`Grok 账单 HTTP ${response.status}`);
  const grpcStatus = response.headers.get('grpc-status');
  if (grpcStatus && grpcStatus !== '0') throw new Error(`Grok 账单 gRPC ${grpcStatus}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const usage = parseGrokBilling(bytes, now);
  const windows = [percentWindow('credits', grokWindowLabel(usage.resetAt, now), usage.usedPercent, usage.resetAt)];
  return {
    ...basePlan('grok', true, statusFor(windows)),
    plan: 'SuperGrok',
    credentialSource: auth.source,
    windows,
  };
}

function parseModelPrices(raw: unknown): ModelPrice[] {
  const models = array(record(raw)?.models);
  const prices: ModelPrice[] = [];
  for (const value of models) {
    const item = record(value);
    const modelId = text(item?.modelId);
    if (!item || !modelId) continue;
    const input = number(item.inputCostPerMillion);
    const output = number(item.outputCostPerMillion);
    const cacheRead = number(item.cacheReadCostPerMillion);
    const cacheCreation = number(item.cacheCreationCostPerMillion);
    if (input === null || output === null || cacheRead === null || cacheCreation === null) continue;
    prices.push({
      modelId,
      displayName: text(item.displayName) ?? modelId,
      inputCostPerMillion: input,
      outputCostPerMillion: output,
      cacheReadCostPerMillion: cacheRead,
      cacheCreationCostPerMillion: cacheCreation,
    });
  }
  return prices;
}

function summarize(plans: UsagePlan[]): UsageSnapshot['summary'] {
  return {
    configured: plans.filter(plan => plan.configured).length,
    connected: plans.filter(plan => plan.configured && plan.status !== 'error').length,
    warnings: plans.filter(plan => plan.status === 'warning').length,
    limited: plans.filter(plan => plan.status === 'limited').length,
    unconfigured: plans.filter(plan => !plan.configured).length,
  };
}

export function createUsageService(options: UsageServiceOptions = {}): UsageService {
  const fetchImpl = options.fetch ?? fetch;
  const env = { ...(options.env ?? process.env) };
  const home = options.home ?? env.HOME?.trim() ?? homedir();
  const pricingPath = options.pricingPath ?? join(home, '.cc-switch', 'model-pricing.json');
  const openCodeConfigPath = join(home, '.config', 'opencode', 'opencode.json');
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cached: UsageSnapshot | null = null;
  let inFlight: Promise<UsageSnapshot> | null = null;

  async function load(): Promise<UsageSnapshot> {
    const generatedAt = Date.now();
    const current = options.loadConfig ? await options.loadConfig() : { config: null as unknown as GraphConfig, env };
    const [openCodeConfig, pricingRaw, pricingInfo] = await Promise.all([
      readJson(openCodeConfigPath).catch(() => null),
      readJson(pricingPath).catch(() => null),
      stat(pricingPath).catch(() => null),
    ]);
    const adapters: { id: UsageProviderId; run: () => Promise<UsagePlan> }[] = [
      { id: 'opencode-go', run: () => fetchOpenCode(current.config, current.env, openCodeConfig, fetchImpl, generatedAt) },
      { id: 'command-goat', run: () => fetchCommandGoat(current.config, current.env, openCodeConfig, fetchImpl, generatedAt) },
      { id: 'deepseek', run: () => fetchDeepSeek(current.config, current.env, fetchImpl) },
      { id: 'chatgpt', run: () => fetchChatGpt(home, current.env, fetchImpl) },
      { id: 'grok', run: () => fetchGrok(home, current.env, fetchImpl, generatedAt) },
    ];
    const plans = await Promise.all(adapters.map(async adapter => {
      try {
        return await adapter.run();
      } catch (error) {
        return {
          ...basePlan(adapter.id, true, 'error'),
          error: errorMessage(error),
        };
      }
    }));
    const snapshot: UsageSnapshot = {
      generatedAt,
      plans,
      pricing: {
        source: '~/.cc-switch/model-pricing.json',
        updatedAt: pricingInfo?.mtimeMs ?? null,
        models: parseModelPrices(pricingRaw),
      },
      summary: summarize(plans),
    };
    cached = snapshot;
    return snapshot;
  }

  return {
    async get(force = false) {
      if (!force && cached && Date.now() - cached.generatedAt < cacheTtlMs) return cached;
      if (inFlight) return inFlight;
      inFlight = load().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
