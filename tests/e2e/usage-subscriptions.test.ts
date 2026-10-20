import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import type { UsageSnapshot } from '../../src/server/usage.ts';
import { findGraphd, graphdSearchStarts } from '../../src/server/go-launch.ts';

let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-usage-native-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(async () => { await rm(webDir, { recursive: true, force: true }); });

// The production billing URLs are fixed HTTPS endpoints. This local CONNECT
// proxy substitutes only external vendors over real TLS/HTTP. Node's supported
// proxy/CA launch options are scoped to the child daemon; fetch and UsageService
// are the unmodified production implementations. No request is forwarded online.
async function vendors(root: string) {
  const names = ['opencode.ai', 'api.commandcode.ai', 'api.deepseek.com', 'chatgpt.com', 'grok.com', 'api.x.ai', 'models.dev'];
  const key = join(root, 'vendor.key'); const cert = join(root, 'vendor.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
    '-subj', '/CN=Graph local subscription vendors', '-addext', `subjectAltName=${names.map(name => `DNS:${name}`).join(',')}`], { stdio: 'pipe' });
  const seen: { host: string; path: string; authorization: string; method: string }[] = [];
  let rolling = 12;
  const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const host = (request.headers.host ?? '').split(':')[0]!; const path = request.url ?? '/';
    const authorization = request.headers.authorization ?? '';
    seen.push({ host, path, authorization, method: request.method ?? '' });
    const json = (body: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (host === 'opencode.ai' && path === '/zen/go/v1/usage') return json({ usage: {
      rolling: { status: 'ok', percent: authorization.includes('work-key') ? 70 : rolling, resetsAt: '2030-09-16T12:00:00Z' },
      weekly: { status: 'ok', percent: 37, resetsAt: '2030-09-20T00:00:00Z' }, monthly: { status: 'ok', percent: 58, resetsAt: '2030-10-01T00:00:00Z' },
    } });
    if (host === 'api.commandcode.ai' && path === '/alpha/billing/credits') return json({
      credits: { monthlyCredits: 46.42, purchasedCredits: 10, freeCredits: 5 },
      windowLimits: { limited: true, fiveHour: { used: 0, cap: 10, resetAt: Date.now() + 3_600_000 }, weekly: { used: 12, cap: 40, resetAt: Date.now() + 86_400_000 } },
    });
    if (host === 'api.commandcode.ai' && path === '/alpha/billing/subscriptions') return json({ success: true, data: { planId: 'individual-goat', currentPeriodEnd: '2030-10-01T00:00:00Z' } });
    if (host === 'api.deepseek.com' && path === '/user/balance') return json({ is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '88.50', granted_balance: '8.50', topped_up_balance: '80.00' }] });
    if (host === 'chatgpt.com' && path === '/backend-api/wham/usage') return json({ plan_type: 'plus', rate_limit: {
      primary_window: { used_percent: 21, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3600 },
      secondary_window: { used_percent: 45, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
    } });
    if (host === 'grok.com' && path === '/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig') {
      const bytes = Buffer.alloc(5); bytes[0] = 13; bytes.writeFloatLE(37.5, 1);
      response.writeHead(200, { 'content-type': 'application/grpc-web+proto' }); response.end(bytes); return;
    }
    if (host === 'models.dev' && path === '/api.json') return json({ 'opencode-go': { models: {
      'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', reasoning: true, limit: { context: 1_000_000, output: 384_000 } },
      'grok-4.6': { name: 'Grok 4.6', reasoning: true, limit: { context: 256_000, output: 64_000 } },
    } } });
    if (host === 'api.commandcode.ai' && path === '/provider/v1/models') return json({ data: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true, context_window: 131_072, max_output_tokens: 8_192 }] });
    if (host === 'api.deepseek.com' && path === '/models') return json({ data: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false, context_window: 65_536, max_output_tokens: 8_192 }] });
    if (host === 'chatgpt.com' && path === '/backend-api/codex/models') return json({ data: [{ id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, context_window: 400_000, max_output_tokens: 128_000 }] });
    if (host === 'api.x.ai' && path === '/v1/models') return json({ data: [{ id: 'grok-4.6', name: 'Grok 4.6', reasoning: true, context_window: 256_000, max_output_tokens: 64_000 }] });
    if (host === 'opencode.ai' && path === '/zen/go/v1/chat/completions') {
      if (request.method !== 'POST' || authorization !== 'Bearer main-key') {
        response.writeHead(401); response.end('Incorrect imported primary credential'); return;
      }
      return json({ id: 'primary-connection-check', choices: [{ message: { role: 'assistant', content: 'pong' } }] });
    }
    if (host === 'api.commandcode.ai' && path === '/provider/v1/chat/completions') {
      if (request.method !== 'POST' || authorization !== 'Bearer command-key') {
        response.writeHead(401); response.end('Incorrect imported credential'); return;
      }
      return json({ id: 'connection-check', choices: [{ message: { role: 'assistant', content: 'pong' } }] });
    }
    response.writeHead(404); response.end('Unexpected vendor request');
  });
  const sockets = new Set<Duplex>();
  tls.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', resolve));
  const address = tls.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture TLS port');
  const proxy = createHttpServer((_request, response) => { response.writeHead(502); response.end('CONNECT required'); });
  proxy.on('connect', (request, client, head) => {
    const [host, port] = (request.url ?? '').split(':');
    if (!host || !names.includes(host) || port !== '443') { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const upstream = connect(address.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address(); if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy port');
  return { seen, cert, url: `http://127.0.0.1:${proxyAddress.port}`, setRolling(value: number) { rolling = value; },
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => tls.close(() => resolve()))]); } };
}

async function daemon(root: string, vendor: Awaited<ReturnType<typeof vendors>>, configured: boolean) {
  const home = join(root, 'home'); await mkdir(home);
  const project = join(root, 'project'); await mkdir(project);
  const configPath = join(root, 'graph.config.json'); const stateDir = join(root, 'state');
  const credentials = configured ? {
    'command-goat': { secretRef: 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY' },
    'opencode-go': { secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', displayName: '主账户' },
    'opencode-go-work': { platform: 'opencode-go', secretRef: 'GRAPH_OPENCODE_WORK_KEY', displayName: '工作账户' },
  } : { 'opencode-go-2': { platform: 'opencode-go', secretRef: 'GRAPH_MISSING_ACCOUNT_KEY', displayName: '账户 2' } };
  await writeFile(configPath, JSON.stringify({ version: 1, revision: 0, projects: [{ id: 'p', root: project }], credentials,
    models: { entries: [{ id: 'zen', provider: 'opencode-go', grade: 'high', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1',
      contextWindow: 1_000_000, maxTokens: 384_000, credentialId: configured ? 'opencode-go' : 'opencode-go-2' },
      ...(configured ? [{ id: 'command-import', provider: 'command-goat', grade: 'medium', api: 'openai-completions',
        baseUrl: 'https://api.commandcode.ai/provider/v1', contextWindow: 131_072, maxTokens: 8_192, credentialId: 'command-goat' }] : []),
    ] } }));
  if (configured) {
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ provider: {
      'opencode-go': { options: { baseURL: 'https://opencode.ai/zen/go/v1', apiKey: 'main-key' } },
      'command-goat': { options: { baseURL: 'https://api.commandcode.ai/provider/v1', apiKey: 'command-key' } },
    } }));
    await mkdir(join(home, '.cc-switch'), { recursive: true });
    await writeFile(join(home, '.cc-switch', 'model-pricing.json'), JSON.stringify({ version: 1, models: [
      { modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', inputCostPerMillion: '0.435', outputCostPerMillion: '0.87', cacheReadCostPerMillion: '0.003625', cacheCreationCostPerMillion: '0' },
      { modelId: 'gpt-5.6', displayName: 'GPT-5.6', inputCostPerMillion: '4', outputCostPerMillion: '20', cacheReadCostPerMillion: '0.4', cacheCreationCostPerMillion: '5' },
    ] }));
  }
  const daemonBin = findGraphd([process.cwd(), ...graphdSearchStarts()]);
  const child = spawn(daemonBin, ['--view-only', '--config', configPath,
    '--state-dir', stateDir, '--graph-home', join(home, '.graph'), '--web-dir', webDir, '--port', '0',
    '--application-root', process.cwd()], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH ?? '', HOME: home, TMPDIR: tmpdir(),
      HTTPS_PROXY: vendor.url, HTTP_PROXY: vendor.url, NO_PROXY: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: vendor.cert,
      ...(configured ? { GRAPH_OPENCODE_WORK_KEY: 'work-key', DEEPSEEK_API_KEY: 'deepseek-key',
        GRAPH_CHATGPT_ACCESS_TOKEN: 'chatgpt-token', GRAPH_GROK_ACCESS_TOKEN: 'grok-token' } : {}),
    },
  });
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const close = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; };
  try {
    const until = Date.now() + 40_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Real daemon exited: ${output}`);
      const text = await readFile(join(stateDir, 'console.json'), 'utf8').catch(() => null);
      if (text) {
        const address = JSON.parse(text) as { url: string; pid: number };
        if (address.pid !== child.pid) throw new Error('Unexpected daemon address owner');
        const response = await fetch(address.url, { headers: { origin: address.url } });
        const cookie = response.headers.get('set-cookie') ?? '';
        return { url: address.url, headers: { origin: address.url, cookie, 'content-type': 'application/json' }, close };
      }
      if (Date.now() > until) throw new Error(`Real daemon did not publish its address: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } catch (error) { await close(); throw error; }
}

test('a real daemon keeps a missing-key account visible without sending empty credentials upstream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-usage-missing-')); const vendor = await vendors(root);
  let server: Awaited<ReturnType<typeof daemon>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = await daemon(root, vendor, false);
    const response = await fetch(`${server.url}/api/usage/refresh`, { method: 'POST', headers: server.headers, body: '{}' }); expect(response.status).toBe(200);
    const snapshot = await response.json() as UsageSnapshot;
    expect(snapshot.plans.filter(plan => plan.platform === 'opencode-go')).toMatchObject([
      { id: 'opencode-go', configured: false, status: 'unconfigured' },
      { id: 'opencode-go#opencode-go-2', account: { id: 'opencode-go-2', name: '账户 2' }, configured: false, status: 'unconfigured', error: null },
    ]);
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto(`${server.url}/#/usage`); await page.getByTestId('usage-page').waitFor();
    expect(await page.getByTestId('usage-plan-deepseek').innerText()).toContain('未检测到凭据');
    expect(await page.getByTestId('usage-plan-opencode-go#opencode-go-2').innerText()).toContain('未检测到凭据');
    expect(await page.getByTestId('usage-plan-account-opencode-go#opencode-go-2').innerText()).toBe('账户 2');
    expect(vendor.seen).toEqual([]);
  } finally { await browser?.close(); await server?.close(); await vendor.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

test('the real usage page normalizes all vendors and per-account credentials, then forces a new quota fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-usage-subscriptions-')); const vendor = await vendors(root);
  let server: Awaited<ReturnType<typeof daemon>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = await daemon(root, vendor, true);
    const response = await fetch(`${server.url}/api/usage/refresh`, { method: 'POST', headers: server.headers, body: '{}' }); expect(response.status).toBe(200);
    const snapshot = await response.json() as UsageSnapshot;
    expect(snapshot.summary).toMatchObject({ configured: 6, connected: 6, unconfigured: 0 });
    const primary = snapshot.plans.find(plan => plan.id === 'opencode-go')!;
    expect(primary).toMatchObject({ platform: 'opencode-go', account: null });
    expect(primary.windows.map(window => window.label)).toEqual(['5 小时', '本周', '本月']);
    expect(primary.windows[0]!.usedPercent).toBe(12);
    expect(snapshot.plans.find(plan => plan.id === 'opencode-go#opencode-go-work')).toMatchObject({ platform: 'opencode-go', account: { id: 'opencode-go-work', name: '工作账户' }, windows: [{ usedPercent: 70 }, {}, {}] });
    const quotaAuth = vendor.seen.filter(row => row.host === 'opencode.ai' && row.path.endsWith('/usage')).map(row => row.authorization);
    expect(quotaAuth).toEqual(expect.arrayContaining(['Bearer main-key', 'Bearer work-key']));
    expect(snapshot.plans.find(plan => plan.id === 'command-goat')!.balance).toMatchObject({ remaining: 46.42, total: 70, used: 23.58 });
    expect(snapshot.plans.find(plan => plan.id === 'deepseek')!.balance).toMatchObject({ remaining: 88.5, currency: 'CNY' });
    expect(snapshot.plans.find(plan => plan.id === 'chatgpt')!.windows).toHaveLength(2);
    expect(snapshot.plans.find(plan => plan.id === 'grok')!.windows[0]!.usedPercent).toBe(37.5);
    expect(vendor.seen.find(row => row.host === 'api.deepseek.com' && row.path === '/user/balance'))
      .toMatchObject({ authorization: 'Bearer deepseek-key' });
    expect(vendor.seen.find(row => row.host === 'chatgpt.com' && row.path === '/backend-api/wham/usage'))
      .toMatchObject({ authorization: 'Bearer chatgpt-token' });
    expect(vendor.seen.find(row => row.host === 'grok.com' && row.path === '/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'))
      .toMatchObject({ method: 'POST', authorization: 'Bearer grok-token' });
    expect(primary.models.map(model => model.id)).toEqual(expect.arrayContaining(['deepseek-v4-pro', 'grok-4.6']));
    expect(primary.models.find(model => model.id === 'deepseek-v4-pro')).toMatchObject({ api: 'openai-completions', headers: { 'x-opencode-session': 'graph-console' } });
    expect(primary.models.find(model => model.id === 'grok-4.6')).toMatchObject({ api: 'responses', supported: false });
    expect(snapshot.plans.find(plan => plan.id === 'command-goat')!.models[0]).toMatchObject({ id: 'deepseek/deepseek-v4-flash', contextWindow: 131_072 });
    expect(snapshot.plans.find(plan => plan.id === 'deepseek')!.models[0]).toMatchObject({ id: 'deepseek-chat', reasoning: false });
    expect(snapshot.plans.find(plan => plan.id === 'chatgpt')!.models[0]).toMatchObject({ id: 'gpt-5.6', supported: false });
    expect(snapshot.plans.find(plan => plan.id === 'grok')!.models[0]).toMatchObject({ id: 'grok-4.6' });
    expect(snapshot.pricing.models.map(model => model.modelId)).toEqual(['deepseek-v4-pro', 'gpt-5.6']);
    const prices = await (await fetch(`${server.url}/api/model-pricing`, { headers: server.headers })).json(); expect(prices).toEqual(snapshot.pricing);
    const credentials = await (await fetch(`${server.url}/api/usage/credentials`, { headers: server.headers })).json();
    expect(credentials).toEqual({ credentials: { 'opencode-go': 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', 'command-goat': 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY',
      deepseek: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY', chatgpt: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN', grok: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' } });
    const connection = await fetch(`${server.url}/api/config/test`, { method: 'POST', headers: server.headers,
      body: JSON.stringify({ modelId: 'command-import' }) });
    expect(connection.status).toBe(200);
    expect(await connection.json()).toMatchObject({ ok: true, model: 'command-import', credentialId: 'command-goat', status: 200 });
    expect(vendor.seen.filter(row => row.host === 'api.commandcode.ai' && row.path === '/provider/v1/chat/completions'))
      .toMatchObject([{ method: 'POST', authorization: 'Bearer command-key' }]);
    const primaryConnection = await fetch(`${server.url}/api/config/test`, { method: 'POST', headers: server.headers,
      body: JSON.stringify({ modelId: 'zen' }) });
    expect(primaryConnection.status).toBe(200);
    expect(await primaryConnection.json()).toMatchObject({ ok: true, model: 'zen', credentialId: 'opencode-go', status: 200 });
    expect(vendor.seen.filter(row => row.host === 'opencode.ai' && row.path === '/zen/go/v1/chat/completions'))
      .toMatchObject([{ method: 'POST', authorization: 'Bearer main-key' }]);
    for (const key of ['main-key', 'work-key', 'command-key', 'deepseek-key', 'chatgpt-token', 'grok-token']) expect(JSON.stringify(snapshot)).not.toContain(key);
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto(`${server.url}/#/usage`); await page.getByTestId('usage-page').waitFor();
    expect(await page.locator('a[href="#/usage"]').getAttribute('aria-label')).toBe('用量');
    expect(await page.getByTestId('usage-plan-opencode-go').innerText()).toContain('OpenCode Go');
    expect(await page.getByTestId('usage-plan-command-goat').innerText()).toContain('$46.42');
    expect(await page.getByTestId('usage-plan-account-opencode-go#opencode-go-work').innerText()).toBe('工作账户');
    expect(await page.getByTestId('usage-pricing').count()).toBe(0); expect(await page.getByTestId('usage-page').innerText()).not.toContain('模型定价');
    const previousCalls = vendor.seen.filter(row => row.path.endsWith('/usage')).length;
    vendor.setRolling(34);
    const refreshed = page.waitForResponse(result => result.url().endsWith('/api/usage/refresh') && result.request().method() === 'POST');
    await page.getByTestId('usage-refresh').click(); expect((await refreshed).status()).toBe(200);
    await expect.poll(() => page.getByTestId('usage-plan-opencode-go').innerText()).toContain('34%');
    expect(vendor.seen.filter(row => row.path.endsWith('/usage')).length).toBeGreaterThan(previousCalls);
  } finally { await browser?.close(); await server?.close(); await vendor.close(); await rm(root, { recursive: true, force: true }); }
}, 90_000);
