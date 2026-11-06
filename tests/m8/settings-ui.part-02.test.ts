import { createServer } from 'node:http';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

import { build } from 'vite';

import { chromium, type Page } from 'playwright';

import { launchCli } from '../helpers/cli-daemon.ts';
import { cleanup, webDir, SECRET, openModelEditor, temp, stubProvider, modelListStubProvider, configFile, start, session } from "./settings-ui.fixture.ts";



test('configured vendor panel edits an account and removes its linked models', async () => {
  const dir = await temp('provider-management');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl);
  const daemon = await start(dir, path);
  const api = await session(daemon.url);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/models`);
  await page.getByTestId('configured-provider-local').waitFor();
  await page.getByTestId('configured-provider-edit-local').click();
  await page.getByTestId('provider-setup').waitFor();
  await expect.poll(() => page.getByTestId('provider-credentialId').inputValue()).toBe('local');
  await expect.poll(() => page.getByTestId('provider-baseUrl').inputValue()).toBe(stub.baseUrl);
  page.once('dialog', dialog => void dialog.accept());
  await page.getByTestId('configured-provider-delete-local').click();
  await expect.poll(async () => {
    const response = await api.get('/api/config');
    const config = (await response.json() as { config: { credentials: Record<string, unknown>; models: { entries: unknown[] } | null } }).config;
    return { credentialCount: Object.keys(config.credentials).length, modelCount: config.models?.entries.length ?? 0 };
  }, { timeout: 10_000 }).toEqual({ credentialCount: 0, modelCount: 0 });
  await page.getByTestId('configured-providers').getByText('尚未配置厂商。').waitFor();
}, 60_000);



test('settings fills new and existing model prices from the local cc-switch snapshot', async () => {
  const dir = await temp('cc-switch-pricing');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl);
  const pricingPath = join(dir, '.cc-switch', 'model-pricing.json');
  await mkdir(join(dir, '.cc-switch'), { recursive: true });
  const writePricing = (localInput: number, manualInput: number) => writeFile(pricingPath, JSON.stringify({
    version: 1,
    models: [
      { modelId: 'local', displayName: 'Local', inputCostPerMillion: localInput, outputCostPerMillion: 20, cacheReadCostPerMillion: 0.4, cacheCreationCostPerMillion: 5 },
      { modelId: 'stub-manual', displayName: 'Stub Manual', inputCostPerMillion: manualInput, outputCostPerMillion: 8, cacheReadCostPerMillion: 0.2, cacheCreationCostPerMillion: 1 },
    ],
  }));
  await writePricing(1, 2);
  const daemon = await start(dir, path);
  const api = await session(daemon.url);
  const configured = async () => {
    const response = await api.get('/api/config');
    return (await response.json() as {
      config: { models: { entries: { id: string; modelId?: string; cost?: { input?: number }; pricing?: { sourceUrl?: string } }[] } };
    }).config.models.entries;
  };

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/models`);
  await page.getByTestId('configured-models').waitFor();
  await expect.poll(async () => (await configured()).find(entry => entry.id === 'local')?.cost?.input).toBe(1);
  expect((await configured()).find(entry => entry.id === 'local')?.pricing?.sourceUrl).toBe('~/.cc-switch/model-pricing.json');

  await openModelEditor(page);
  await page.getByTestId('model-vendor-select').selectOption('local');
  await page.getByTestId('model-manual-id').fill('stub-manual');
  await page.getByTestId('model-manual-add').click();
  await page.getByTestId('model-add-selected').click();
  const manual = page.locator('[data-testid^="provider-model-"]').filter({ hasText: 'stub-manual' });
  await manual.waitFor();
  expect(await manual.locator('[data-testid$="-price"]').innerText()).toContain('输入 2');
  const index = (await manual.getAttribute('data-testid'))!.replace('provider-model-', '');
  await page.getByTestId(`model-${index}-context`).fill('4096');
  await page.getByTestId(`model-${index}-maxTokens`).fill('256');
  await page.getByTestId(`model-${index}-grade`).selectOption('high');
  await expect.poll(async () => (await configured()).find(entry => entry.modelId === 'stub-manual')?.cost?.input).toBe(2);

  await writePricing(3, 4);
  await page.reload();
  await page.getByTestId('configured-models').waitFor();
  await expect.poll(async () => (await configured()).find(entry => entry.id === 'local')?.cost?.input).toBe(3);
  await expect.poll(async () => (await configured()).find(entry => entry.modelId === 'stub-manual')?.cost?.input).toBe(4);
}, 90_000);



test('settings imports detected subscription credentials without exposing their values', async () => {
  const dir = await temp('subscription-sync');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl);
  await mkdir(join(dir, '.config', 'opencode'), { recursive: true });
  await writeFile(join(dir, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    provider: {
      'command-goat': {
        options: { baseURL: 'https://api.commandcode.ai/provider/v1', apiKey: 'subscription-test-key' },
        models: { 'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash' } },
      },
    },
  }));
  const daemon = await start(dir, path);
  const api = await session(daemon.url);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/settings`);
  await page.getByTestId('settings-page').waitFor();
  await expect.poll(async () => (await (await api.get('/api/config')).json() as { revision: number }).revision, { timeout: 10_000 }).toBe(1);
  const payload = await (await api.get('/api/config')).json() as {
    config: { credentials: Record<string, { secretRef: string; configured: boolean }> };
  };
  expect(payload.config.credentials['command-goat']).toMatchObject({
    secretRef: 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY',
    configured: true,
  });
  expect(JSON.stringify(payload)).not.toContain('subscription-test-key');
}, 60_000);



test('switching the account in step one follows through to the model list in step two', async () => {
  const dir = await temp('account-model-list');
  const first = await modelListStubProvider(['alpha-1', 'alpha-2']);
  const second = await modelListStubProvider(['beta-1']);
  const path = join(dir, 'graph.config.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    projects: [{ id: 'sample', root: dir }],
    models: {
      entries: [
        { id: 'alpha', provider: 'alpha-endpoint', grade: 'medium', api: 'openai-completions', baseUrl: first, contextWindow: 2048, maxTokens: 128, credentialId: 'alpha-account' },
        { id: 'beta', provider: 'beta-endpoint', grade: 'medium', api: 'openai-completions', baseUrl: second, contextWindow: 2048, maxTokens: 128, credentialId: 'beta-account' },
      ],
    },
    credentials: { 'alpha-account': { secretRef: 'GRAPH_ALPHA_KEY' }, 'beta-account': { secretRef: 'GRAPH_BETA_KEY' } },
    limits: { credentials: { 'alpha-account': 1, 'beta-account': 1 } },
  }, null, 2));
  const daemon = await launchCli(dir, { configPath: path, stateDir: join(dir, 'state'), webDir,
    env: { HOME: dir, GRAPH_ALPHA_KEY: SECRET, GRAPH_BETA_KEY: SECRET } });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/models`);
  await page.getByTestId('settings-page').waitFor();
  await openModelEditor(page);

  // Step two lists the selected account's own models.
  await page.getByTestId('model-vendor-select').selectOption('alpha-account');
  await expect.poll(() => page.getByTestId('model-probe-alpha-1').count(), { timeout: 20_000 }).toBe(1);

  // Switching the account in step one has to move the list with it. Those rows were fetched from alpha's
  // endpoint: leaving them on screen while the form configures beta is how one account's models end up
  // saved under another.
  await page.getByTestId('provider-credentialId').fill('beta-account');
  await expect.poll(() => page.getByTestId('model-probe-beta-1').count(), { timeout: 20_000 }).toBe(1);
  expect(await page.getByTestId('model-probe-alpha-1').count()).toBe(0);
}, 90_000);



test('an account whose own key has no value is not reported as resolved', async () => {
  const dir = await temp('account-missing-key');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl, {
    credentials: { 'opencode-go-2': { platform: 'opencode-go', secretRef: 'GRAPH_OPENCODE_GO_ACCOUNT_2', displayName: '账户 2' } },
  });
  // The platform-level variable exists - which is exactly what let this card claim 凭据已解析 for an account
  // that has no value of its own. The only symptom of that lie is a model that silently never dispatches.
  const daemon = await launchCli(dir, { configPath: path, stateDir: join(dir, 'state'), webDir,
    env: { HOME: dir, GRAPH_SYNTH_KEY: SECRET, GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY: SECRET } });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/models`);
  await page.getByTestId('settings-page').waitFor();
  await openModelEditor(page);
  await page.getByTestId('provider-platform-opencode-go').click();
  await page.getByTestId('provider-credentialId').fill('opencode-go-2');

  // One platform may hold several accounts: another account's variable says nothing about this one.
  await expect.poll(async () => page.getByTestId('provider-credential-state').innerText(), { timeout: 10_000 }).toContain('凭据缺失');
  // And the card names the variable this account needs, not the platform preset's.
  expect(await page.getByTestId('provider-key-env').innerText()).toContain('GRAPH_OPENCODE_GO_ACCOUNT_2');
}, 60_000);



test('the vendor card keeps its fields readable instead of crowding them', async () => {
  const dir = await temp('card-crowding');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl);
  const daemon = await launchCli(dir, { configPath: path, stateDir: join(dir, 'state'), webDir,
    env: { HOME: dir, GRAPH_SYNTH_KEY: SECRET } });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${daemon.url}/#/models`);
  await page.getByTestId('settings-page').waitFor();
  await openModelEditor(page);
  await page.getByTestId('provider-platform-opencode-go').click();

  // Two things a person actually needs from this card, both measurable: the variable name they must export
  // has to be readable in full (an input clips it silently - scrollWidth > clientWidth), and each field's
  // hint has to sit on its own line instead of wrapping the label into an orphan word.
  const measured = await page.evaluate(() => {
    const card = document.querySelector('#settings-credentials') as HTMLElement;
    const input = card.querySelector('[data-testid="provider-credentialRef"]') as HTMLInputElement;
    const crowded = [...card.querySelectorAll('.field')].filter(field => {
      const label = field.querySelector('.field-label') as HTMLElement | null;
      const hint = field.querySelector('.field-hint') as HTMLElement | null;
      if (!label || !hint) return false;
      return hint.getBoundingClientRect().top <= label.getBoundingClientRect().top + 2;
    });
    // Fields sharing a grid row must line their inputs up: a hint on only some of them otherwise pushes
    // those inputs a line lower, which is the misalignment that replaced the crowding after the first fix.
    const rows = new Map<number, number[]>();
    for (const field of card.querySelectorAll('.card-grid > .field, .card-grid > .field-full > .field')) {
      const control = field.querySelector('input, select') as HTMLElement | null;
      if (!control) continue;
      const row = Math.round(field.getBoundingClientRect().top / 40);
      rows.set(row, [...(rows.get(row) ?? []), Math.round(control.getBoundingClientRect().top)]);
    }
    const misalignedRows = [...rows.values()].filter(tops => new Set(tops).size > 1).length;
    return {
      envVar: input.value,
      envFits: input.scrollWidth <= input.clientWidth + 1,
      envWidth: Math.round(input.getBoundingClientRect().width),
      sharedLineHints: crowded.length,
      misalignedRows,
    };
  });
  expect(measured.envVar).toBe('GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY');
  expect(measured.envFits).toBe(true);
  expect(measured.envWidth).toBeGreaterThan(300);
  expect(measured.sharedLineHints).toBe(0);
  expect(measured.misalignedRows).toBe(0);
}, 60_000);
