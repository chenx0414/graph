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



test('settings auto-save models, credentials and limits without leaking secrets', async () => {
  const dir = await temp('edit');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl);
  const daemon = await start(dir, path);
  const api = await session(daemon.url);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.clock.install();
  const savedDocuments: string[] = [];
  page.on('response', response => {
    const request = response.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/config' && response.status() === 200) {
      savedDocuments.push(JSON.stringify((request.postDataJSON() as { document: unknown }).document));
    }
  });
  await page.goto(`${daemon.url}/#/settings`);
  await page.getByTestId('settings-page').waitFor();
  expect(await page.getByTestId('config-revision').count(), 'the removed revision card is back').toBe(0);
  expect(await page.getByTestId('config-revisions').getAttribute('data-revision')).toBe('0');
  expect(await page.locator('body').innerText()).not.toContain(SECRET);
  expect(await page.getByTestId('theme-placeholder').count(), 'the removed appearance placeholder is back').toBe(0);
  expect(await page.locator('body').innerText()).not.toContain('当前使用浅色主题');
  const openPage = async (label: '模型' | '常规') => {
    await page.evaluate(hash => { location.hash = hash; }, label === '模型' ? '#/models' : '#/settings');
    await page.getByTestId(label === '模型' ? 'models-page' : 'settings-shell').waitFor();
    if (label === '模型') await openModelEditor(page);
  };

  await page.evaluate(() => { location.hash = '#/models'; });
  await page.getByTestId('configured-models').waitFor();
  expect(await page.getByTestId('model-editor-toggle').getAttribute('aria-expanded')).toBe('false');
  await page.getByRole('button', { name: '连接厂商' }).click();
  await page.getByTestId('provider-setup').waitFor();
  expect(await page.evaluate(() => location.hash)).toBe('#/models');
  expect(await page.locator('#settings-credentials').isVisible()).toBe(true);
  expect(await page.locator('#settings-models').isVisible()).toBe(true);
  expect(await page.locator('#settings-preferences').count()).toBe(0);
  // B-1 replaced the single-page editor with the two-step flow: ① 配置厂商
  // (credential + inline caps), ② 选择模型.
  expect(await page.getByTestId('provider-setup').isVisible()).toBe(true);
  expect(await page.locator('#settings-project').count()).toBe(0);
  expect(await page.getByTestId('settings-save').count()).toBe(0);
  expect(await page.getByTestId('settings-reload').count()).toBe(0);
  expect(await page.getByTestId('settings-action-strip').count()).toBe(0);
  // ③ the caps live inside the vendor card; no standalone 高级设置 region is left,
  // and their ids are keyed by the credential of the selected vendor.
  expect(await page.locator('#settings-limits').count()).toBe(0);
  expect(await page.getByTestId('provider-concurrency').isVisible()).toBe(true);
  expect(await page.getByTestId('limit-credential-local').count()).toBe(0);
  // Browser mode has no keychain channel, so the page shows guidance (reason +
  // desktop path + env var name + copyable export line) instead of a key input.
  expect(await page.getByTestId('provider-key').count()).toBe(0);
  expect(await page.getByTestId('provider-key-guidance').isVisible()).toBe(true);
  expect(await page.getByTestId('provider-key-hint').innerText()).toContain('浏览器');
  expect(await page.getByTestId('provider-key-export').innerText()).toBe('export GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY=…');
  expect(await page.getByTestId('provider-key-copy').isVisible()).toBe(true);
  expect(stub.requests).toHaveLength(0);

  // ① configure a custom vendor whose credential is the fixture `local`, so the
  // model that already uses it shows up in step ②.
  await page.getByTestId('provider-platform-custom').click();
  await page.getByTestId('provider-label').fill('本地网关');
  await page.getByTestId('provider-baseUrl').fill(stub.baseUrl);
  await page.getByTestId('provider-credentialId').fill('local');
  await page.getByTestId('provider-credentialRef').fill('GRAPH_SYNTH_KEY');
  // ③ both caps are edited inside this card and saved with the same document.
  await expect.poll(async () => page.getByTestId('limit-credential-local').inputValue(), { timeout: 10_000 }).toBe('1');
  await page.getByTestId('limit-credential-local').fill('2');
  await page.getByTestId('limit-group-id-local').fill('group-1');
  await page.getByTestId('limit-group-local').fill('4');
  expect(await page.getByTestId('provider-credential-state').innerText()).toContain('凭据已解析');
  await page.getByTestId('provider-save').click();
  // ① 保存并验证 really sends a minimal request. The stub answers /models with a
  // non-list body, so only the explicit model under this credential can be
  // verified - skipping verification there is the defect this asserts against.
  // Readiness waits for that chat request by its path, not for a request count: naming an account that
  // already exists also makes step ② follow that account, which probes once (see the account-switch test).
  await expect.poll(async () => stub.requests.some(request => request.path === '/v1/chat/completions'), { timeout: 15_000 }).toBe(true);
  expect(stub.requests.some(request => request.path === '/v1/models')).toBe(true);
  expect(stub.requests.find(request => request.path === '/v1/chat/completions')).toMatchObject({ model: 'local', authorization: `Bearer ${SECRET}` });
  expect(await page.getByTestId('provider-verification').innerText()).toContain('验证成功');
  await expect.poll(async () => (await (await api.get('/api/config')).json() as { revision: number }).revision, { timeout: 10_000 }).toBe(1);
  await page.getByTestId('config-status').waitFor();
  expect(await page.getByTestId('config-status').innerText()).toContain('已自动保存 revision 1');
  // ② 选择模型 offers only configured vendors: the custom vendor just saved
  // (credential `local`) is present, an unconfigured preset is not.
  const vendorOptions = await page.getByTestId('model-vendor-select').innerText();
  expect(vendorOptions).toContain('本地网关');
  expect(vendorOptions).not.toContain('Grok');
  const beforeVendorPick = stub.requests.length;
  await page.getByTestId('model-vendor-select').selectOption('local');
  // 选择厂商会自动取 /models（不用再点按钮）；而在 ① 里已经把凭据 id 写成一个已存在账户时，
  // ② 已经跟着它取过一次了（那正是账户跟随修复要做的事），所以这里的契约是「这个端点被取过"+
  // 「失败的列表如实报出来」，不是请求次数。
  expect(beforeVendorPick).toBeGreaterThanOrEqual(1);
  expect(stub.requests.filter(request => request.path === '/v1/models').length).toBeGreaterThanOrEqual(1);
  // The failed list is reported instead of pretending a list arrived, and an id
  // typed by hand stays visible as a row the user can pick.
  await expect.poll(async () => page.getByTestId('model-probe-note').innerText(), { timeout: 15_000 }).toContain('模型列表');
  await page.getByTestId('model-manual-id').fill('stub-manual');
  await page.getByTestId('model-manual-add').click();
  expect(await page.getByTestId('model-probe-stub-manual').count()).toBe(1);
  await page.getByTestId('model-add-selected').click();
  await page.getByTestId('model-1-price').waitFor();
  // ② metadata that the snapshot does not know stays unknown - never 0.
  expect(await page.getByTestId('model-1-price').innerText()).toContain('价格未知');
  await page.getByTestId('model-1-context').fill('4096');
  await page.getByTestId('model-1-maxTokens').fill('256');
  // ② The added id is persisted with its typed-in required fields, and it keeps
  // reporting an unknown price instead of a fake 0.
  await expect.poll(async () => ((await (await api.get('/api/config')).json() as { config: { models: { entries: { modelId?: string }[] } } }).config.models.entries.some(entry => entry.modelId === 'stub-manual')), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => page.locator('[data-testid^="configured-model-"]').count()).toBe(2);
  await page.getByRole('textbox', { name: '搜索已配置模型' }).fill('stub-manual');
  expect(await page.locator('[data-testid^="configured-model-"]').count()).toBe(1);
  await page.getByRole('textbox', { name: '搜索已配置模型' }).fill('');
  const configured = (await (await api.get('/api/config')).json() as { config: { models: { entries: { id: string; modelId?: string }[] } } }).config.models.entries;
  const manualLocalId = configured.find(entry => entry.modelId === 'stub-manual')!.id;
  await page.getByTestId(`configured-default-${manualLocalId}`).click();
  await expect.poll(async () => (await (await api.get('/api/settings')).json() as { defaultModel: string }).defaultModel, { timeout: 10_000 }).toBe(manualLocalId);
  expect(await page.getByTestId('configured-default-model').innerText()).toBe('stub-manual');
  // Seeing the model/default does not mean the last model edit has saved.
  // Finish the browser's writes before introducing the deliberate stale-read race.
  await expect.poll(async () => {
    const models = (await (await api.get('/api/config')).json() as { config: { models: { entries: { id: string; contextWindow: number; maxTokens: number }[] } } }).config.models.entries;
    return models.find(entry => entry.id === manualLocalId);
  }).toMatchObject({ contextWindow: 4096, maxTokens: 256 });
  // Both configured models stay listed: the tier filter that used to narrow this
  // list to one row is gone with the tiers themselves.
  expect(await page.locator('[data-testid^="configured-model-"]').count()).toBe(2);
  expect(await page.getByTestId(`configured-model-${manualLocalId}`).innerText()).not.toContain('frontier');
  await expect.poll(() => page.getByTestId('config-status').innerText()).toContain('已自动保存 revision');
  // Advance the real browser's debounce timers after the save receipt, with no new edit.
  await page.clock.fastForward(1_000);
  await api.get('/api/config');
  // Successful autosave must not schedule another write of the same unchanged draft.
  expect(savedDocuments.some((document, index) => index > 0 && document === savedDocuments[index - 1])).toBe(false);

  // Race the two real startup snapshots: the startup response is captured
  // before a hot save, while the config GET is delivered after that save.
  let releaseStartup!: () => void; let releaseConfig!: () => void; let startupCaptured!: () => void;
  const startupGate = new Promise<void>(resolve => { releaseStartup = resolve; });
  const configGate = new Promise<void>(resolve => { releaseConfig = resolve; });
  const captured = new Promise<void>(resolve => { startupCaptured = resolve; });
  cleanup.push(() => { releaseStartup(); releaseConfig(); });
  await page.route('**/api/startup', async route => {
    const response = await route.fetch(); startupCaptured(); await startupGate; await route.fulfill({ response });
  });
  await page.route('**/api/config', async route => {
    if (route.request().method() === 'GET') await configGate;
    await route.continue();
  });
  await openPage('常规'); await captured;
  const raceDocument = JSON.parse(await readFile(path, 'utf8')) as { revision: number };
  const beforeRace = raceDocument.revision;
  const hotSave = await api.post('/api/config', { expectedRevision: beforeRace, document: raceDocument });
  const hotSaveBody = await hotSave.json() as { revision: number; effectiveRevision: number };
  expect(hotSave.status, JSON.stringify(hotSaveBody)).toBe(200);
  const savedRevision = hotSaveBody.revision;
  expect(savedRevision).toBeGreaterThan(beforeRace);
  releaseConfig();
  await expect.poll(async () => Number(await page.getByTestId('config-revisions').getAttribute('data-revision'))).toBeGreaterThanOrEqual(savedRevision);
  releaseStartup();
  // The source card is rendered by the same handler as the delayed startup
  // revision, so waiting for it observes that response rather than a timer.
  await page.getByTestId('source-root').waitFor();
  // Hot apply: the running build is never behind the revision saved by the time the
  // page opened, and no restart is requested. A snapshot equality against a revision
  // read once raced with the page's own auto-save (and a substring check could pass
  // on a later revision), so the invariant is compared instead.
  await expect.poll(async () => {
    const shown = Number((await page.getByTestId('config-revisions').getAttribute('data-effective-revision'))?.trim());
    return Number.isFinite(shown) && shown >= savedRevision;
  }, { timeout: 15_000 }).toBe(true);
  expect(await page.getByTestId('restart-required').count()).toBe(0);

  // Persistence across a browser reload: the inline caps and the unknown price
  // come back with the card (the custom draft itself is re-typed, see the note in
  // the B-1 hand-over report).
  await page.reload();
  await page.getByTestId('settings-page').waitFor();
  await openPage('模型');
  await page.getByTestId('provider-platform-custom').click();
  await page.getByTestId('provider-credentialId').fill('local');
  // ② the picker persists too: re-selecting the configured vendor brings back the
  // models under it (and auto-fetches again, which is fine).
  await page.getByTestId('model-vendor-select').selectOption('local');
  await expect.poll(async () => page.getByTestId('limit-credential-local').inputValue(), { timeout: 10_000 }).toBe('2');
  await expect.poll(async () => page.getByTestId('limit-group-id-local').inputValue(), { timeout: 10_000 }).toBe('group-1');
  await expect.poll(async () => page.getByTestId('limit-group-local').inputValue(), { timeout: 10_000 }).toBe('4');
  // The added model survives the reload: the card list holds both entries and the
  // one without snapshot metadata still reports an unknown price.
  await expect.poll(async () => page.locator('[data-testid^="provider-model-"]').count(), { timeout: 10_000 }).toBe(2);
  expect(await page.locator('[data-testid^="provider-model-"] [data-testid$="-price"]').first().innerText()).toContain('价格未知');
  expect(await page.locator('body').innerText()).not.toContain(SECRET);

  // Persistence across a daemon restart on the same state and config.
  await daemon.close();
  const restarted = await start(dir, path);
  const restartedApi = await session(restarted.url);
  const configText = await (await restartedApi.get('/api/config')).text();
  // The settings page auto-saves, so a further save can land after the read above; what must
  // hold is that the save persisted and the revision never went backwards.
  const restartedConfig = JSON.parse(configText) as { revision: number };
  expect(restartedConfig.revision).toBeGreaterThanOrEqual(savedRevision);
  expect(JSON.parse(configText)).toMatchObject({ config: { projects: [{ id: 'sample' }] } });
  expect(configText).not.toContain(SECRET);
  const persisted = (JSON.parse(configText) as {
    revision: number;
    config: {
      credentials: Record<string, { secretRef: string }>;
      models: { entries: { modelId?: string; contextWindow?: number; maxTokens?: number; pricing?: { status?: string } }[] };
      limits: { credentials: Record<string, number>; sharedGroups: Record<string, number> };
    };
  }).config;
  const afterRestart = JSON.parse(configText) as { revision: number };
  expect(afterRestart.revision).toBeGreaterThanOrEqual(savedRevision);
  // ④ only the reference is stored, never the secret value.
  expect(persisted.credentials.local?.secretRef).toBe('GRAPH_SYNTH_KEY');
  // ② an id added without snapshot metadata is persisted as unknown, not as 0.
  const added = persisted.models.entries.find(entry => entry.modelId === 'stub-manual');
  expect(added).toMatchObject({ contextWindow: 4096, maxTokens: 256 });
  // No price was invented: an unknown price stays absent, never a 0.
  expect(added).not.toHaveProperty('cost');
  expect(added).not.toHaveProperty('pricing');
  // ③ the inline caps are part of the same saved document.
  expect(persisted.limits.credentials.local).toBe(2);
  expect(persisted.limits.sharedGroups['group-1']).toBe(4);

  // Nothing is sent without an explicit action, and the vendor card is ready to
  // act: ① already proved above that an explicit 保存并验证 reaches the right
  // vendor with the right credential (the custom draft is re-typed after a
  // restart, see the hand-over report).
  await page.goto(`${restarted.url}/#/settings`);
  await page.getByTestId('settings-page').waitFor();
  await openPage('模型');
  await page.getByTestId('provider-platform-custom').click();
  await page.getByTestId('provider-baseUrl').fill(stub.baseUrl);
  await page.getByTestId('provider-credentialId').fill('local');
  const sent = stub.requests.length;
  expect(sent).toBeGreaterThan(0);
  await expect.poll(async () => stub.requests.length, { timeout: 10_000 }).toBe(sent);
  await expect.poll(async () => page.getByTestId('provider-credential-state').innerText(), { timeout: 10_000 }).toContain('凭据已解析');

  // An edit the daemon refuses never replaces the saved document, and the console
  // keeps showing the revision that is really in effect.
  const saved = await (await restartedApi.get('/api/config')).text();
  const revision = (JSON.parse(saved) as { revision: number }).revision;
  const document = (JSON.parse(saved) as { config: { models: { entries: { id: string }[] } } }).config;
  const duplicate = structuredClone(document) as { models: { entries: { id: string }[] } };
  duplicate.models.entries[1]!.id = duplicate.models.entries[0]!.id;
  const refused = await restartedApi.post('/api/config', { expectedRevision: revision, document: duplicate });
  expect(refused.status).toBe(400);
  expect(await (await restartedApi.get('/api/config')).text()).toBe(saved);
  await openPage('常规');
  expect(await page.getByTestId('config-revisions').getAttribute('data-revision')).toBe(String(revision));
}, 120_000);
