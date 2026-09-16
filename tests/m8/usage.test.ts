import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { createUsageService, type UsageService, type UsageSnapshot } from '../../src/server/usage.ts';

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
  expect(snapshot.pricing.models.map(model => model.modelId)).toEqual(['deepseek-v4-pro', 'gpt-5.6']);
  expect(requests).toHaveLength(6);
});

test('the usage page shows subscription cards, refreshes, and keeps pricing visible', async () => {
  const root = await temp('ui');
  let forced = false;
  const snapshot: UsageSnapshot = {
    generatedAt: Date.now(),
    plans: [
      {
        id: 'opencode-go', name: 'OpenCode Go', subtitle: 'openCode.ai · 5 小时滚动额度', configured: true, status: 'ok', plan: 'Go',
        credentialSource: 'OpenCode 配置 · opencode-go', windows: [
          { id: 'rolling', label: '5 小时', usedPercent: 12, remainingPercent: 88, resetAt: Date.now() + 3_600_000 },
          { id: 'weekly', label: '本周', usedPercent: 37, remainingPercent: 63, resetAt: Date.now() + 86_400_000 },
        ], balance: null, details: {}, error: null, updatedAt: Date.now(),
      },
      {
        id: 'command-goat', name: 'Command Goat', subtitle: 'CommandCode · 月度订阅额度', configured: true, status: 'warning', plan: 'GOAT',
        credentialSource: 'OpenCode 配置 · command-goat', windows: [
          { id: 'monthly', label: '本月', usedPercent: 82, remainingPercent: 18, resetAt: Date.now() + 86_400_000, used: 57.4, limit: 70, unit: 'USD' },
        ], balance: { remaining: 12.6, used: 57.4, total: 70, currency: 'USD', unit: '$' }, details: {}, error: null, updatedAt: Date.now(),
      },
      { id: 'deepseek', name: 'DeepSeek', subtitle: 'DeepSeek 官方 API · 账户余额', configured: false, status: 'unconfigured', plan: null, credentialSource: null, windows: [], balance: null, details: {}, error: null, updatedAt: Date.now() },
      { id: 'grok', name: 'Grok', subtitle: 'xAI SuperGrok · 周期额度', configured: false, status: 'unconfigured', plan: null, credentialSource: null, windows: [], balance: null, details: {}, error: null, updatedAt: Date.now() },
      { id: 'chatgpt', name: 'ChatGPT', subtitle: 'ChatGPT Codex · 官方订阅额度', configured: false, status: 'unconfigured', plan: null, credentialSource: null, windows: [], balance: null, details: {}, error: null, updatedAt: Date.now() },
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
