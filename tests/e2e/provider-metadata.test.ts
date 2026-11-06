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
import { webDir, cleanup, providerMap } from "./provider-metadata.fixture.ts";



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
  expect((await disk()).limits).toEqual({ credentials: { 'opencode-go': 5 }, sharedGroups: { team: 9 } });
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
  await expect.poll(async () => (await disk()).limits).toEqual({ credentials: {}, sharedGroups: {} });
  expect((await disk()).credentials['opencode-go']).not.toHaveProperty('sharedLimitGroupId');
}, 90_000);
