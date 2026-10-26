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
  // The platform's "already configured" state is derived from the daemon's own
  // environment: a machine that runs Graph on the opencode-go subscription has
  // GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY set, so the platform looks
  // configured, the wizard rightly stops asking for a key, and the very error
  // this test asserts never appears. The daemon must start without it for the
  // unresolved case to exist at all; the assertion itself is unchanged.
  const daemon = await launchCli(root, { configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    env: { HOME: root, GRAPH_LOCAL_KEY: 'synthetic-key', GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY: '' }, extraArgs: ['--dynamic'] });
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
