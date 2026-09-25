import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { createUsageService, type UsageService, type UsageSnapshot } from '../../src/server/usage.ts';
import type { GraphConfig } from '../../src/server/config.ts';
import { defaultAccessPolicy } from '../../src/core/access-policy.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-usage-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([
      Promise.resolve(action()).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 8_000)),
    ]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-usage-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function grokPayload(percent: number) {
  const bytes = Buffer.alloc(5);
  bytes[0] = 13;
  bytes.writeFloatLE(percent, 1);
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
}

test('a platform with several accounts reports every account with its own quota', async () => {
  const home = await temp('accounts');
  const config: GraphConfig = {
    path: join(home, 'graph.config.json'), configured: true, projects: [],
    access: defaultAccessPolicy(), piExtensionAutoUpdate: false,
    credentials: {
      'opencode-go': { secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', displayName: '主账户' },
      'opencode-go-work': { platform: 'opencode-go', secretRef: 'GRAPH_OPENCODE_WORK_KEY', displayName: '工作账户' },
    },
    models: {
      preferences: {},
      entries: [{
        id: 'zen', provider: 'opencode-go', grade: 'high', api: 'openai-completions',
        baseUrl: 'https://opencode.ai/zen/go/v1', contextWindow: 1_000_000, maxTokens: 384_000, credentialId: 'opencode-go',
      }],
    },
    limits: { credentials: {}, sharedGroups: {}, defaultBudgetTokens: null },
  };
  const env = {
    HOME: home,
    GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY: 'main-key',
    GRAPH_OPENCODE_WORK_KEY: 'work-key',
  };
  const seen: string[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://opencode.ai/zen/go/v1/usage') {
      const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
      const authorization = headers.authorization ?? '';
      seen.push(authorization);
      const percent = authorization.includes('work-key') ? 70 : 12;
      return json({ usage: { rolling: { status: 'ok', percent, resetsAt: '2026-09-16T12:00:00Z' } } });
    }
    if (url === 'https://models.dev/api.json') return json({});
    return new Response('not found', { status: 404 });
  };
  const service = createUsageService({
    home, fetch: fetchImpl, env,
    pricingPath: join(home, 'model-pricing.json'),
    loadConfig: async () => ({ config, env }),
  });

  const snapshot = await service.get(true);
  const accounts = snapshot.plans.filter(plan => plan.platform === 'opencode-go');
  // The platform's own credential keeps the plan it always had; the extra account
  // is its own row, so nothing a single-account setup relies on changes shape.
  expect(accounts).toHaveLength(2);
  expect(accounts[0]).toMatchObject({ id: 'opencode-go', platform: 'opencode-go', account: null });
  expect(accounts[1]).toMatchObject({
    id: 'opencode-go#opencode-go-work', platform: 'opencode-go',
    account: { id: 'opencode-go-work', name: '工作账户' },
  });
  expect(accounts[0]?.windows[0]?.usedPercent).toBe(12);
  expect(accounts[1]?.windows[0]?.usedPercent).toBe(70);
  // Each account asked with its own key, which is the point of the feature.
  expect(seen.some(value => value.includes('main-key'))).toBe(true);
  expect(seen.some(value => value.includes('work-key'))).toBe(true);
  // The summary counts accounts, not platforms.
  expect(snapshot.summary.configured).toBe(2);
});

test('usage service normalizes the five supported subscription sources', async () => {
  const home = await temp('service');
  const pricingPath = join(home, 'model-pricing.json');
  const openCodeConfig = join(home, '.config', 'opencode', 'opencode.json');
  await mkdir(join(home, '.config', 'opencode'), { recursive: true });
  await writeFile(openCodeConfig, JSON.stringify({
    provider: {
      'opencode-go': { options: { baseURL: 'https://opencode.ai/zen/go/v1', apiKey: 'opencode-key' } },
      'command-goat': { options: { baseURL: 'https://api.commandcode.ai/provider/v1', apiKey: 'command-key' } },
    },
  }));
  await writeFile(pricingPath, JSON.stringify({
    version: 1,
    models: [
      { modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', inputCostPerMillion: '0.435', outputCostPerMillion: '0.87', cacheReadCostPerMillion: '0.003625', cacheCreationCostPerMillion: '0' },
      { modelId: 'gpt-5.6', displayName: 'GPT-5.6', inputCostPerMillion: '4', outputCostPerMillion: '20', cacheReadCostPerMillion: '0.4', cacheCreationCostPerMillion: '5' },
    ],
  }));
  const requests: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === 'https://opencode.ai/zen/go/v1/usage') {
      return json({ usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: '2026-09-16T12:00:00Z' },
        weekly: { status: 'ok', percent: 37, resetsAt: '2026-09-20T00:00:00Z' },
        monthly: { status: 'ok', percent: 58, resetsAt: '2026-10-01T00:00:00Z' },
      } });
    }
    if (url.endsWith('/alpha/billing/credits')) {
      return json({
        credits: { monthlyCredits: 46.42, purchasedCredits: 10, freeCredits: 5 },
        windowLimits: {
          limited: true,
          fiveHour: { used: 0, cap: 10, resetAt: Date.now() + 3_600_000 },
          weekly: { used: 12, cap: 40, resetAt: Date.now() + 86_400_000 },
        },
      });
    }
    if (url.endsWith('/alpha/billing/subscriptions')) {
      return json({ success: true, data: { planId: 'individual-goat', currentPeriodEnd: '2026-10-01T00:00:00Z' } });
    }
    if (url === 'https://api.deepseek.com/user/balance') {
      return json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.50', granted_balance: '8.50', topped_up_balance: '80.00' }] });
    }
    if (url === 'https://chatgpt.com/backend-api/wham/usage') {
      return json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 21, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3_600 }, secondary_window: { used_percent: 45, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 86_400 } } });
    }
    if (url === 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig') return grokPayload(37.5);
    if (url === 'https://models.dev/api.json') {
      return json({ 'opencode-go': { models: {
        'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', reasoning: true, limit: { context: 1_000_000, output: 384_000 } },
        'grok-4.6': { name: 'Grok 4.6', reasoning: true, limit: { context: 256_000, output: 64_000 } },
      } } });
    }
    if (url === 'https://api.commandcode.ai/provider/v1/models') {
      return json({ data: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true, context_window: 131_072, max_output_tokens: 8_192 }] });
    }
    if (url === 'https://api.deepseek.com/models') {
      return json({ data: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false, context_window: 65_536, max_output_tokens: 8_192 }] });
    }
    if (url === 'https://chatgpt.com/backend-api/codex/models') {
      return json({ data: [{ id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, context_window: 400_000, max_output_tokens: 128_000 }] });
    }
    if (url === 'https://api.x.ai/v1/models') {
      return json({ data: [{ id: 'grok-4.6', name: 'Grok 4.6', reasoning: true, context_window: 256_000, max_output_tokens: 64_000 }] });
    }
    return new Response('not found', { status: 404 });
  };
  const service = createUsageService({
    home,
    pricingPath,
    fetch: fetchImpl,
    env: {
      HOME: home,
      DEEPSEEK_API_KEY: 'deepseek-key',
      GRAPH_CHATGPT_ACCESS_TOKEN: 'chatgpt-token',
      GRAPH_GROK_ACCESS_TOKEN: 'grok-token',
    },
  });

  const snapshot = await service.get(true);
  expect(snapshot.summary).toMatchObject({ configured: 5, connected: 5, unconfigured: 0 });
  expect(snapshot.plans.find(plan => plan.id === 'opencode-go')?.windows.map(window => window.label)).toEqual(['5 小时', '本周', '本月']);
  expect(snapshot.plans.find(plan => plan.id === 'command-goat')?.balance).toMatchObject({ remaining: 46.42, total: 70, used: 23.58 });
  expect(snapshot.plans.find(plan => plan.id === 'deepseek')?.balance).toMatchObject({ remaining: 88.5, currency: 'CNY' });
  expect(snapshot.plans.find(plan => plan.id === 'chatgpt')?.windows).toHaveLength(2);
  expect(snapshot.plans.find(plan => plan.id === 'grok')?.windows[0]?.usedPercent).toBe(37.5);
  const openCodeModels = snapshot.plans.find(plan => plan.id === 'opencode-go')?.models ?? [];
  expect(openCodeModels.map(model => model.id)).toEqual(expect.arrayContaining(['deepseek-v4-pro', 'grok-4.6']));
  expect(openCodeModels.find(model => model.id === 'deepseek-v4-pro')).toMatchObject({
    api: 'openai-completions',
    headers: { 'x-opencode-session': 'graph-console' },
  });
  expect(openCodeModels.find(model => model.id === 'grok-4.6')).toMatchObject({ api: 'responses', supported: false });
  expect(snapshot.plans.find(plan => plan.id === 'command-goat')?.models[0]).toMatchObject({ id: 'deepseek/deepseek-v4-flash', contextWindow: 131_072 });
  expect(snapshot.plans.find(plan => plan.id === 'deepseek')?.models[0]).toMatchObject({ id: 'deepseek-chat', reasoning: false });
  expect(snapshot.plans.find(plan => plan.id === 'chatgpt')?.models[0]).toMatchObject({ id: 'gpt-5.6', supported: false });
  expect(snapshot.plans.find(plan => plan.id === 'grok')?.models[0]).toMatchObject({ id: 'grok-4.6' });
  expect(snapshot.pricing.models.map(model => model.modelId)).toEqual(['deepseek-v4-pro', 'gpt-5.6']);
  expect(await service.credentials()).toEqual({
    'opencode-go': 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY',
    'command-goat': 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY',
    deepseek: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY',
    chatgpt: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN',
    grok: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN',
  });
  expect(await service.secretValues()).toMatchObject({
    GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY: 'opencode-key',
    GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY: 'command-key',
    GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY: 'deepseek-key',
    GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN: 'chatgpt-token',
    GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: 'grok-token',
  });
  expect(requests).toHaveLength(11);
});

test('the usage page shows subscription cards, refreshes, and keeps pricing visible', async () => {
  const root = await temp('ui');
  let forced = false;
  const snapshot: UsageSnapshot = {
    generatedAt: Date.now(),
    plans: [
      {
        id: 'opencode-go', platform: 'opencode-go', account: null, name: 'OpenCode Go', subtitle: 'openCode.ai · 5 小时滚动额度', configured: true, status: 'ok', plan: 'Go',
        credentialSource: 'OpenCode 配置 · opencode-go',
        credential: { id: 'opencode-go', secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', source: 'OpenCode 配置 · opencode-go', configured: true },
        models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true, supported: true }],
        windows: [
          { id: 'rolling', label: '5 小时', usedPercent: 12, remainingPercent: 88, resetAt: Date.now() + 3_600_000 },
          { id: 'weekly', label: '本周', usedPercent: 37, remainingPercent: 63, resetAt: Date.now() + 86_400_000 },
        ], balance: null, details: {}, error: null, updatedAt: Date.now(),
      },
      {
        id: 'command-goat', platform: 'command-goat', account: null, name: 'Command Goat', subtitle: 'CommandCode · 月度订阅额度', configured: true, status: 'warning', plan: 'GOAT',
        credentialSource: 'OpenCode 配置 · command-goat',
        credential: { id: 'command-goat', secretRef: 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY', source: 'OpenCode 配置 · command-goat', configured: true },
        models: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', api: 'openai-completions', baseUrl: 'https://api.commandcode.ai/provider/v1', contextWindow: 131_072, maxTokens: 8_192, reasoning: true, supported: true }],
        windows: [
          { id: 'monthly', label: '本月', usedPercent: 82, remainingPercent: 18, resetAt: Date.now() + 86_400_000, used: 57.4, limit: 70, unit: 'USD' },
        ], balance: { remaining: 12.6, used: 57.4, total: 70, currency: 'USD', unit: '$' }, details: {}, error: null, updatedAt: Date.now(),
      },
      { id: 'deepseek', platform: 'deepseek', account: null, name: 'DeepSeek', subtitle: 'DeepSeek 官方 API · 账户余额', configured: false, status: 'unconfigured', plan: null, credentialSource: null, credential: null, models: [], windows: [], balance: null, details: {}, error: null, updatedAt: Date.now() },
      { id: 'grok', platform: 'grok', account: null, name: 'Grok', subtitle: 'xAI SuperGrok · 周期额度', configured: false, status: 'unconfigured', plan: null, credentialSource: null, credential: null, models: [], windows: [], balance: null, details: {}, error: null, updatedAt: Date.now() },
      { id: 'chatgpt', platform: 'chatgpt', account: null, name: 'ChatGPT', subtitle: 'ChatGPT Codex · 官方订阅额度', configured: false, status: 'unconfigured', plan: null, credentialSource: null, credential: null, models: [], windows: [], balance: null, details: {}, error: null, updatedAt: Date.now() },
    ],
    pricing: {
      source: '~/.cc-switch/model-pricing.json',
      updatedAt: Date.now(),
      models: [{ modelId: 'gpt-5.6', displayName: 'GPT-5.6', inputCostPerMillion: 4, outputCostPerMillion: 20, cacheReadCostPerMillion: 0.4, cacheCreationCostPerMillion: 5 }],
    },
    summary: { configured: 2, connected: 2, warnings: 1, limited: 0, unconfigured: 3 },
  };
  const usage: UsageService = {
    async get(force = false) {
      forced = force;
      return snapshot;
    },
    async credentials() {
      return { 'opencode-go': 'OPENCODE_GO_API_KEY' };
    },
    async secretValues() {
      return {};
    },
  };
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
    usage,
  });
  cleanup.push(() => server.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/usage`);
  await page.getByTestId('usage-page').waitFor();
  expect(await page.locator('a[href="#/usage"]').innerText()).toContain('用量');
  expect(await page.getByTestId('usage-plan-opencode-go').innerText()).toContain('OpenCode Go');
  expect(await page.getByTestId('usage-plan-command-goat').innerText()).toContain('$12.60');
  expect(await page.getByTestId('usage-plan-deepseek').innerText()).toContain('未检测到凭据');
  expect(await page.getByTestId('usage-pricing').innerText()).toContain('GPT-5.6');
  await page.getByTestId('usage-refresh').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="usage-refresh"]')?.textContent?.includes('刷新用量'));
  expect(forced).toBe(true);
});
