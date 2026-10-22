import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { launchCli } from '../helpers/cli-daemon.ts';
import { vendorProxy } from '../helpers/vendor-proxy.ts';

let webDir: string;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-e2e-metadata-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const providerMap = { custom: { id: 'custom', models: {
  flagship: { id: 'flagship', reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'bogus', 'max'] }], modalities: { input: ['text', 'image', 'pdf'] }, limit: { context: 200_000, output: 32_000 }, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, currency: 'EUR' } },
  partial: { id: 'partial', modalities: { input: ['text'] }, limit: { context: 8_000, output: 2_000 }, cost: { input: 2, output: 8 } },
} } };

// Catalog data is the external fixture. The browser still runs the shipped mapper/editor and saves through the real daemon.
test.each(['meta', 'legacy', 'bare'] as const)('the model editor consumes %s catalog data and persists complete metadata without inventing defaults', async format => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-metadata-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const vendor = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'flagship' }, { id: 'partial' }] }));
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1`;
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY', displayName: 'Gateway' } }, models: { entries: [{ id: 'seed', provider: 'custom', grade: 'high', api: 'openai-completions', baseUrl, contextWindow: 2048, maxTokens: 128, credentialId: 'local' }] } }));
  const daemon = await launchCli(root, { configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    env: { HOME: root, GRAPH_LOCAL_KEY: 'synthetic-catalog-key' }, extraArgs: ['--dynamic'] });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const meta = { sourceUrl: 'https://catalog.example.test/api.json', fetchedAt: '2026-01-02T03:04:05.000Z', attribution: 'Fixture catalog' };
  const snapshot = format === 'meta' ? { _meta: meta, providers: providerMap } : format === 'legacy' ? { ...meta, providers: providerMap } : providerMap;
  let catalogRequests = 0;
  await page.route('**/*models-dev.snapshot*.json', route => { catalogRequests += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }); });
  await page.goto(`${daemon.url}/#/models`);
  if (await page.getByTestId('model-editor-toggle').getAttribute('aria-expanded') === 'false') await page.getByTestId('model-editor-toggle').click();
  await page.getByTestId('model-vendor-select').selectOption('local');
  await page.getByTestId('model-probe-flagship').waitFor();
  await page.getByTestId('model-probe-flagship').check();
  await page.getByTestId('model-add-selected').click();
  await page.getByTestId('model-1-context').waitFor();
  expect(catalogRequests).toBe(1);
  expect(await page.getByTestId('model-1-context').inputValue()).toBe('200000');
  expect(await page.getByTestId('model-1-maxTokens').inputValue()).toBe('32000');
  expect(await page.getByTestId('model-1-images').isChecked()).toBe(true);
  expect(await page.getByTestId('model-1-grade').inputValue()).toBe('');
  expect(await page.getByTestId('model-1-price').innerText()).toContain('EUR');
  expect(await page.getByTestId('model-1-thinking').locator('option').allTextContents()).not.toContain('bogus');
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));
  expect((await disk()).models.entries).toHaveLength(1);
  await page.getByTestId('model-1-grade').selectOption('high');
  await expect.poll(async () => (await disk()).models.entries.find((entry: { modelId?: string }) => entry.modelId === 'flagship')).toMatchObject({ contextWindow: 200_000, maxTokens: 32_000, input: ['text', 'image'], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, pricing: { currency: 'EUR', unit: 'per_million_tokens', status: 'known' } });
  const saved = (await disk()).models.entries.find((entry: { modelId?: string }) => entry.modelId === 'flagship');
  expect(saved).not.toHaveProperty('defaultThinkingLevel');
  if (format !== 'bare') expect(saved.pricing).toMatchObject({ sourceUrl: meta.sourceUrl, catalogRevision: `models-dev.${meta.fetchedAt}` });
  await page.getByTestId('model-probe-partial').check();
  await page.getByTestId('model-add-selected').click();
  await page.getByTestId('model-2-context').waitFor();
  expect(await page.getByTestId('model-2-price').innerText()).toContain('价格未知');
  await page.getByTestId('model-2-grade').selectOption('medium');
  await expect.poll(async () => (await disk()).models.entries.find((entry: { modelId?: string }) => entry.modelId === 'partial')).toMatchObject({ contextWindow: 8000, maxTokens: 2000 });
  expect((await disk()).models.entries.find((entry: { modelId?: string }) => entry.modelId === 'partial')).not.toHaveProperty('cost');
  await page.getByTestId('model-manual-id').fill('unlisted');
  await page.getByTestId('model-manual-add').click();
  await page.getByTestId('model-manual-id').fill('unlisted');
  await page.getByTestId('model-manual-add').click();
  expect(await page.getByTestId('model-probe-unlisted').count()).toBe(1);
  await page.getByTestId('model-probe').click();
  await page.getByTestId('model-probe-unlisted').waitFor();
  expect(await page.getByTestId('model-probe-unlisted').isChecked()).toBe(true);
  await page.getByTestId('model-add-selected').click();
  await page.getByTestId('model-3-context').waitFor();
  expect(await page.getByTestId('model-3-context').inputValue()).toBe('');
  expect(await page.getByTestId('model-3-maxTokens').inputValue()).toBe('');
  expect(await page.getByTestId('model-3-price').innerText()).toContain('价格未知');
  await page.getByTestId('model-3-context').fill('9999');
  await page.getByTestId('model-3-maxTokens').fill('1234');
  await page.getByTestId('model-3-grade').selectOption('high');
  await expect.poll(async () => (await disk()).models.entries.find((entry: { modelId?: string }) => entry.modelId === 'unlisted')).toMatchObject({ contextWindow: 9999, maxTokens: 1234 });
  await page.getByTestId('model-3-input-cost').fill('5');
  await expect.poll(() => page.getByTestId('model-3-cost-error').innerText()).toContain('成套');
  expect((await disk()).models.entries.find((entry: { modelId?: string }) => entry.modelId === 'unlisted')).not.toHaveProperty('cost');
  for (const side of ['input', 'output', 'cache-read', 'cache-write']) await page.getByTestId(`model-3-${side}-cost`).fill('0');
  await expect.poll(async () => (await disk()).models.entries.find((entry: { modelId?: string }) => entry.modelId === 'unlisted')?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  await page.getByTestId('model-3-context').fill('8765');
  await page.getByTestId('model-probe').click();
  await expect.poll(async () => (await disk()).models.entries.find((entry: { modelId?: string }) => entry.modelId === 'unlisted')?.contextWindow).toBe(8765);
}, 90_000);

test('provider account edits keep credential identity, names and concurrency while new accounts stay independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-accounts-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: { path: string; auth: string | undefined }[] = [];
  const vendor = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    requests.push({ path: request.url ?? '', auth: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url?.endsWith('/models') ? { data: [{ id: 'space-bunny-free' }] } : { choices: [] }));
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;
  // The daemon owns its own process, so the preset vendor endpoint is redirected
  // at the network layer: the daemon's real proxy and CA settings carry the
  // request to this controlled vendor.
  const proxy = await vendorProxy(root, ['opencode.ai'], baseUrl);
  cleanup.push(() => proxy.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: {
    'opencode-go': { secretRef: 'GRAPH_CUSTOM_FIRST', displayName: '工作账户', platform: 'opencode-go', sharedLimitGroupId: 'old-group' },
    'opencode-go-2': { secretRef: 'GRAPH_CUSTOM_SECOND', displayName: '备用账户', platform: 'opencode-go' },
  }, limits: { credentials: { 'opencode-go': 3 }, sharedGroups: { 'old-group': 8 } }, models: { entries: [{ id: 'go-model', provider: 'opencode-go', modelId: 'space-bunny-free', grade: 'high', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'opencode-go' }] } }));
  const daemon = await launchCli(root, { configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    env: { HOME: root, ...proxy.env, GRAPH_CUSTOM_FIRST: 'first-synthetic-key', GRAPH_CUSTOM_SECOND: 'second-synthetic-key', GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY: 'preset-synthetic-key', GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY_3: 'third-synthetic-key' }, extraArgs: ['--dynamic'] });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/settings`);
  await expect.poll(() => page.locator('.settings-nav-item').allTextContents()).toEqual(['常规', '归档对话']);
  await page.locator('.settings-nav-item').filter({ hasText: '归档对话' }).click();
  await page.locator('#settings-archived').waitFor();
  await page.locator('.settings-nav-item').filter({ hasText: '常规' }).click();
  await page.locator('#settings-overview').waitFor();
  expect(await page.getByRole('heading', { name: '高级设置', exact: true }).count()).toBe(0);
  await page.goto(`${daemon.url}/#/models`);
  const configView = await (await page.request.get(`${daemon.url}/api/config`)).json();
  expect(configView.config.credentials['opencode-go-2']).toMatchObject({ platform: 'opencode-go', secretRef: 'GRAPH_CUSTOM_SECOND' });
  if (await page.getByTestId('model-editor-toggle').getAttribute('aria-expanded') === 'false') await page.getByTestId('model-editor-toggle').click();
  await page.getByTestId('provider-platform-opencode-go').click();
  await expect.poll(() => page.getByTestId('provider-label').inputValue()).toBe('工作账户');
  expect(await page.getByTestId('provider-credentialRef').inputValue()).toBe('GRAPH_CUSTOM_FIRST');
  expect(await page.getByTestId('limit-credential-opencode-go').inputValue()).toBe('3');
  expect(await page.getByTestId('limit-group-id-opencode-go').inputValue()).toBe('old-group');
  expect(await page.getByTestId('limit-group-opencode-go').inputValue()).toBe('8');
  expect(await page.locator('#settings-limits').count()).toBe(0);
  expect(await page.getByTestId('provider-key').count()).toBe(0);
  expect(await page.getByTestId('provider-key-guidance').innerText()).toContain('浏览器无法访问系统钥匙串');
  expect(await page.getByTestId('provider-key-guidance').innerText()).toContain('桌面 App 窗口');
  await page.getByTestId('provider-label').fill('工作账户 · 已命名');
  await page.getByTestId('limit-credential-opencode-go').fill('5');
  await page.getByTestId('limit-group-id-opencode-go').fill('team');
  await page.getByTestId('limit-group-opencode-go').fill('9');
  await page.getByTestId('provider-save').click();
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));
  await expect.poll(async () => (await disk()).credentials['opencode-go']).toMatchObject({ secretRef: 'GRAPH_CUSTOM_FIRST', displayName: '工作账户 · 已命名', platform: 'opencode-go', sharedLimitGroupId: 'team' });
  expect((await disk()).limits).toEqual({ defaultBudgetTokens: null, credentials: { 'opencode-go': 5 }, sharedGroups: { team: 9 } });
  await expect.poll(() => page.getByTestId('provider-verification').innerText()).toContain('验证成功');
  expect(requests.some(request => request.auth === 'Bearer first-synthetic-key')).toBe(true);
  await page.getByTestId('configured-provider-edit-opencode-go-2').click();
  await expect.poll(() => page.getByTestId('provider-label').inputValue()).toBe('备用账户');
  for (const id of ['limit-credential-opencode-go-2', 'limit-group-id-opencode-go-2', 'limit-group-opencode-go-2']) expect(await page.getByTestId(id).count()).toBe(1);
  expect(await page.getByTestId('provider-credentialRef').inputValue()).toBe('GRAPH_CUSTOM_SECOND');
  await page.getByTestId('provider-add-account').click();
  expect(await page.getByTestId('provider-credentialId').inputValue()).toBe('opencode-go-3');
  expect(await page.getByTestId('provider-credentialRef').inputValue()).toBe('GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY_3');
  await page.getByTestId('provider-label').fill('第三账户');
  await page.getByTestId('provider-save').click();
  await expect.poll(async () => ({
    credential: (await disk()).credentials['opencode-go-3'],
    resolution: await page.getByTestId('provider-credential-state').innerText(),
    keyError: await page.getByTestId('provider-key-error').count() ? await page.getByTestId('provider-key-error').innerText() : null,
    configError: await page.getByTestId('config-error').count() ? await page.getByTestId('config-error').innerText() : null,
  })).toMatchObject({ credential: { secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY_3', displayName: '第三账户', platform: 'opencode-go' } });
  await expect.poll(() => requests.some(request => request.auth === 'Bearer third-synthetic-key')).toBe(true);
  expect((await disk()).credentials['opencode-go-2']).toMatchObject({ secretRef: 'GRAPH_CUSTOM_SECOND', displayName: '备用账户' });
  expect(JSON.stringify(await disk())).not.toContain('synthetic-key');
  await page.getByTestId('configured-provider-edit-opencode-go').click();
  await expect.poll(() => page.getByTestId('limit-credential-opencode-go').inputValue()).toBe('5');
  await page.getByTestId('limit-credential-opencode-go').fill('0');
  await page.getByTestId('limit-group-id-opencode-go').fill('');
  await page.getByTestId('provider-save').click();
  await expect.poll(async () => (await disk()).limits).toEqual({ defaultBudgetTokens: null, credentials: {}, sharedGroups: {} });
  expect((await disk()).credentials['opencode-go']).not.toHaveProperty('sharedLimitGroupId');
}, 90_000);

test('real provider fields reject missing keys and malformed custom configuration before writing or sending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-provider-validation-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const vendor = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    requests.push(request.url ?? '');
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'subscription does not allow listing' } }));
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1`;
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } } }));
  const original = await readFile(configPath, 'utf8');
  const daemon = await launchCli(root, { configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    env: { HOME: root, GRAPH_LOCAL_KEY: 'synthetic-key' }, extraArgs: ['--dynamic'] });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/models`);
  if (await page.getByTestId('model-editor-toggle').getAttribute('aria-expanded') === 'false') await page.getByTestId('model-editor-toggle').click();
  const picker = page.getByTestId('provider-platforms');
  await picker.getByRole('searchbox', { name: '搜索服务商' }).fill('api.anthropic.com');
  await page.getByTestId('provider-platform-anthropic').click();
  expect(await page.getByTestId('provider-baseUrl').inputValue()).toBe('https://api.anthropic.com');
  const brand = picker.getByTestId('provider-platform-anthropic').locator('img');
  await expect.poll(() => brand.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(await page.getByRole('link', { name: '获取 Anthropic API 凭据 ↗' }).getAttribute('href')).toContain('claude.com');
  await picker.getByRole('searchbox').fill('');
  await picker.getByRole('combobox', { name: '服务商类型' }).selectOption('subscription');
  expect(await picker.getByTestId('provider-platform-anthropic').count()).toBe(0);
  await picker.getByTestId('provider-platform-opencode-go').click();
  await page.getByTestId('provider-save').click();
  await expect.poll(() => page.getByTestId('provider-key-error').innerText()).toContain('环境变量');
  expect(requests).toHaveLength(0);
  expect(await readFile(configPath, 'utf8')).toBe(original);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
  await picker.getByRole('searchbox').fill('missing provider xyz');
  await picker.getByRole('status').filter({ hasText: '没有匹配' }).waitFor();
  await page.getByTestId('provider-platform-custom').click();
  await page.getByTestId('provider-save').click();
  expect(await page.getByTestId('provider-label').getAttribute('data-invalid')).toBe('true');
  expect(await page.getByTestId('provider-baseUrl').getAttribute('data-invalid')).toBe('true');
  await page.getByTestId('provider-label').fill('Gateway');
  await page.getByTestId('provider-baseUrl').fill('ftp://invalid');
  await page.getByTestId('provider-credentialId').fill('Bad Id');
  await page.getByTestId('provider-credentialRef').fill('1-bad');
  await page.getByTestId('provider-save').click();
  for (const field of ['baseUrl', 'credentialId', 'credentialRef']) expect(await page.getByTestId(`provider-${field}`).getAttribute('data-invalid')).toBe('true');
  expect(requests).toHaveLength(0);
  expect(await readFile(configPath, 'utf8')).toBe(original);
  await page.getByTestId('provider-baseUrl').fill(baseUrl);
  await page.getByTestId('provider-credentialId').fill('local');
  await page.getByTestId('provider-credentialRef').fill('GRAPH_LOCAL_KEY');
  await page.getByTestId('provider-save').click();
  await expect.poll(() => page.getByTestId('provider-verification').innerText()).toContain('subscription does not allow listing');
  await expect.poll(async () => JSON.parse(await readFile(configPath, 'utf8')).credentials.local.displayName).toBe('Gateway');
  expect(requests).toContain('/v1/models');
  expect(JSON.parse(await readFile(configPath, 'utf8')).credentials.local).not.toHaveProperty('platform');
  await page.reload();
  await page.getByTestId('configured-provider-local').waitFor();
  expect(await page.getByTestId('configured-provider-local').innerText()).toContain('Gateway');
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  expect(saved.credentials.local.secretRef).toBe('GRAPH_LOCAL_KEY');
  expect(JSON.stringify(saved)).not.toContain('synthetic-key');
}, 90_000);

test('the setup wizard keeps two connections to one upstream model and repeated saves preserve the first identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-setup-identities-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const auth: string[] = [];
  const vendor = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    auth.push(request.headers.authorization ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [] }));
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1`;
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }] }));
  const daemon = await launchCli(root, { configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    env: { HOME: root, OPENAI_API_KEY: 'first-setup-key', ANTHROPIC_API_KEY: 'second-setup-key' }, extraArgs: ['--dynamic'] });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/setup`);
  const setupPicker = page.getByTestId('setup-providers');
  await setupPicker.getByRole('searchbox').fill('deepseek');
  await page.getByTestId('setup-provider-deepseek').click();
  expect(await page.getByTestId('setup-providers').getByRole('button', { pressed: true }).innerText()).toContain('DeepSeek');
  await setupPicker.getByRole('searchbox').fill('');
  const configure = async (provider: 'openai' | 'anthropic') => {
    await page.getByTestId(`setup-provider-${provider}`).click();
    for (const checkbox of await page.getByTestId('setup-models').locator('input[type="checkbox"]').all()) await checkbox.uncheck();
    await page.getByTestId('setup-model-add').click();
    await page.getByTestId('setup-custom-model-0').locator('input').fill('same-model');
    await page.getByTestId('setup-advanced-toggle').click();
    await page.getByTestId('setup-base-url').fill(baseUrl);
    await page.getByTestId('setup-api').selectOption('openai-completions');
  };
  const save = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'POST');
    await page.getByTestId('setup-save').click();
    expect(await (await response).json()).toMatchObject({ applied: true });
  };
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));
  await configure('openai');
  await save();
  expect((await disk()).models.entries).toMatchObject([{ id: 'same-model', modelId: 'same-model', provider: 'openai', credentialId: 'openai' }]);
  await save();
  expect((await disk()).models.entries).toHaveLength(1);
  await page.getByTestId('setup-advanced-toggle').click();
  await configure('anthropic');
  await save();
  expect((await disk()).models.entries).toMatchObject([{ id: 'same-model', modelId: 'same-model', provider: 'openai', credentialId: 'openai' }, { id: 'same-model-anthropic', modelId: 'same-model', provider: 'anthropic', credentialId: 'anthropic' }]);
  expect((await disk()).credentials).toMatchObject({ openai: { secretRef: 'OPENAI_API_KEY' }, anthropic: { secretRef: 'ANTHROPIC_API_KEY' } });
  expect(auth).toHaveLength(0);
  for (const modelId of ['same-model', 'same-model-anthropic']) {
    const response = await page.request.post(`${daemon.url}/api/config/test`, { headers: { origin: daemon.url }, data: { modelId } });
    expect(await response.json()).toMatchObject({ ok: true });
  }
  expect(auth).toEqual(['Bearer first-setup-key', 'Bearer second-setup-key']);
}, 90_000);
