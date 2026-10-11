import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';
import type { NativeProposal } from '../../src/core/types.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-settings-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([
      Promise.resolve(action()).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ]);
  }
  cleanup.length = 0;
});

const SECRET = 'synth-settings-secret';

async function openModelEditor(page: Page) {
  const toggle = page.getByTestId('model-editor-toggle');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByTestId('provider-setup').waitFor();
}

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-settings-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function stubProvider() {
  const requests: { model?: string; authorization?: string; path?: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { model?: string } : {};
    requests.push({ ...(body.model ? { model: body.model } : {}), ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), ...(request.url ? { path: request.url } : {}) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { requests, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

/** A vendor that answers `/models` with its own list, so step ② has rows to fetch and an account switch has
 * something to follow. */
async function modelListStubProvider(ids: string[]) {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    if ((request.url ?? '').includes('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: ids.map(id => ({ id, name: id.toUpperCase() })) }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function configFile(dir: string, baseUrl: string, extra: Record<string, unknown> = {}) {
  const path = join(dir, 'graph.config.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    projects: [{ id: 'sample', root: dir }],
    models: { entries: [{ id: 'local', provider: 'stub', grade: 'medium', api: 'openai-completions', baseUrl, contextWindow: 2048, maxTokens: 128, credentialId: 'local' }] },
    credentials: { local: { secretRef: 'GRAPH_SYNTH_KEY' }, ...(extra.credentials ?? {}) },
    limits: { credentials: { local: 1 } },
  }, null, 2));
  return path;
}

async function start(dir: string, path: string, port = 0): Promise<GraphDaemon> {
  const daemon = await startGraphDaemon({ configPath: path, stateDir: join(dir, 'state'), webDir, port, mode: 'view', env: { HOME: dir, GRAPH_SYNTH_KEY: SECRET }, log: () => undefined });
  cleanup.push(() => daemon.close().catch(() => undefined));
  return daemon;
}

async function session(url: string) {
  const home = await fetch(url, { headers: { origin: url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  const headers = { origin: url, cookie, 'content-type': 'application/json' };
  return {
    get: (path: string) => fetch(`${url}${path}`, { headers }),
    post: (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

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
  expect(await page.getByTestId('config-revision').innerText()).toBe('0');
  expect(await page.locator('body').innerText()).not.toContain(SECRET);
  expect(await page.getByTestId('theme-placeholder').isVisible()).toBe(true);
  expect(await page.getByTestId('theme-system').getAttribute('data-active')).toBe('true');
  await page.getByTestId('theme-dark').click();
  expect(await page.getByTestId('theme-dark').getAttribute('data-active')).toBe('true');
  await page.getByTestId('theme-system').click();
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
  await page.getByTestId('model-1-grade').selectOption('frontier');
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
    const models = (await (await api.get('/api/config')).json() as { config: { models: { entries: { id: string; grade: string; contextWindow: number; maxTokens: number }[] } } }).config.models.entries;
    return models.find(entry => entry.id === manualLocalId);
  }).toMatchObject({ grade: 'frontier', tier: 'frontier', contextWindow: 4096, maxTokens: 256 });
  await page.getByTestId('model-tier-filter').selectOption('frontier');
  expect(await page.locator('[data-testid^="configured-model-"]').count()).toBe(1);
  expect(await page.getByTestId(`configured-model-${manualLocalId}`).innerText()).toContain('frontier');
  await page.getByTestId('model-tier-filter').selectOption('small');
  expect(await page.locator('[data-testid^="configured-model-"]').count()).toBe(0);
  await page.getByTestId('model-tier-filter').selectOption('');
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
  await expect.poll(async () => Number(await page.getByTestId('config-revision').innerText())).toBeGreaterThanOrEqual(savedRevision);
  releaseStartup();
  // The source card is rendered by the same handler as the delayed startup
  // revision, so waiting for it observes that response rather than a timer.
  await page.getByTestId('source-root').waitFor();
  // Hot apply: the running build is never behind the revision saved by the time the
  // page opened, and no restart is requested. A snapshot equality against a revision
  // read once raced with the page's own auto-save (and a substring check could pass
  // on a later revision), so the invariant is compared instead.
  await expect.poll(async () => {
    const shown = Number((await page.getByTestId('effective-revision').innerText()).trim());
    return Number.isFinite(shown) && shown >= savedRevision;
  }, { timeout: 15_000 }).toBe(true);
  const revisionPill = page.getByTestId('effective-revision').locator('xpath=..');
  await expect.poll(async () => (await revisionPill.innerText()).includes('正在同步'), { timeout: 15_000 }).toBe(false);
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
  const restarted = await start(dir, path, 0);
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
      models: { entries: { modelId?: string; contextWindow?: number; maxTokens?: number; grade?: string; pricing?: { status?: string } }[] };
      limits: { credentials: Record<string, number>; sharedGroups: Record<string, number> };
    };
  }).config;
  const afterRestart = JSON.parse(configText) as { revision: number };
  expect(afterRestart.revision).toBeGreaterThanOrEqual(savedRevision);
  // ④ only the reference is stored, never the secret value.
  expect(persisted.credentials.local?.secretRef).toBe('GRAPH_SYNTH_KEY');
  // ② an id added without snapshot metadata is persisted as unknown, not as 0.
  const added = persisted.models.entries.find(entry => entry.modelId === 'stub-manual');
  expect(added).toMatchObject({ contextWindow: 4096, maxTokens: 256, grade: 'frontier' });
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
  expect(await page.getByTestId('config-revision').innerText()).toBe(String(revision));
}, 120_000);

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

test('chat composer toggles full access with one click and settings no longer hosts the control', async () => {
  const dir = await temp('access-mode');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl);
  const daemon = await start(dir, path);
  const api = await session(daemon.url);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/`);
  const toggle = page.getByTestId('full-access-toggle');
  await toggle.waitFor();
  // The page loads its config asynchronously, so every attribute is polled to the value the
  // fetched config implies: a bare assertion right after waitFor races that load under the
  // parallel gate (it failed once as `expected 'false' to be 'true'`).
  await expect.poll(() => toggle.evaluate(element => element.parentElement?.classList.contains('chat-composer-controls')), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => toggle.getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true');
  await expect.poll(() => toggle.innerText(), { timeout: 10_000 }).toContain('完全访问');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect.poll(() => page.locator('.new-chat-composer .chat-composer-controls').evaluate(element => element.scrollWidth <= element.clientWidth + 1), { timeout: 10_000 }).toBe(true);

  await toggle.click();
  await expect.poll(async () => (await (await api.get('/api/config')).json() as { revision: number }).revision, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => toggle.getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('false');
  const standard = await (await api.get('/api/config')).json() as { config: { access: { mode: string; filesystem: { read: string } } } };
  expect(standard.config.access).toMatchObject({ mode: 'standard', filesystem: { read: 'workspace-and-bound' } });

  await toggle.click();
  await expect.poll(async () => (await (await api.get('/api/config')).json() as { revision: number }).revision, { timeout: 10_000 }).toBe(2);
  await expect.poll(() => toggle.getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true');
  const full = await (await api.get('/api/config')).json() as { config: { access: { mode: string; filesystem: { read: string } } } };
  expect(full.config.access).toMatchObject({ mode: 'full', filesystem: { read: 'host' } });

  await page.goto(`${daemon.url}/#/settings`);
  await page.getByTestId('settings-page').waitFor();
  expect(await page.locator('.settings-nav-item').filter({ hasText: '访问模式' }).count()).toBe(0);

  const created = await (await api.post('/api/conversations', {
    text: '测试聊天输入区的完全访问开关。',
    requestId: 'full-access-toggle-conversation',
  })).json() as { conversationId: string };
  await page.goto(`${daemon.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('full-access-toggle').waitFor();
}, 120_000);

test('removing a model bound to an unfinished task is refused and the daemon keeps the binding', async () => {
  const dir = await temp('guard');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl);
  const daemon = await start(dir, path);
  const api = await session(daemon.url);
  const { taskId: anchorTaskId, conversationId } = await daemon.server.runtime.conversations.create({ projectId: 'sample', text: 'Keep binding', requestId: 'begin' });
  await daemon.server.runtime.supervisor(anchorTaskId).propose({
    requirementVersion: 1, summary: 'Keep binding',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: 'Keep binding', protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Keep the declared model', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} } },
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
      edges: {}, acceptance: [{ id: 'works', description: 'Works', kind: 'check', module: 'check' }] }),
  }, 'proposal');
  await daemon.server.runtime.projects.prepare({ projectId: 'sample', initialize: true, createBaseline: true, requestId: 'prepare' });
  const { taskId } = await daemon.server.runtime.conversations.confirm(conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  const document = {
    version: 1, projects: [{ id: 'sample', root: dir }],
    models: { entries: [{ id: 'replacement', provider: 'stub', grade: 'medium', api: 'openai-completions', baseUrl: stub.baseUrl, contextWindow: 2048, maxTokens: 128, credentialId: 'local' }] }, credentials: { local: { secretRef: 'GRAPH_SYNTH_KEY' } }, limits: { credentials: { local: 1 } },
  };
  const refused = await api.post('/api/config', { expectedRevision: 0, document });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'config_in_use' });
  const view = await daemon.server.runtime.user.task(taskId).view();
  expect(view.nodes.find(node => node.id === 'work')?.status).toBe('idle');
  expect(daemon.server.runtime.modelsInUse()).toContain('local');
  const revision = await daemon.server.runtime.supervisor(taskId).graphInspect({ graphId: taskId, query: 'revision' }) as { nodes: { work: { model: string } } };
  expect(revision.nodes.work.model).toBe('local');
  expect((await (await api.get('/api/config')).json() as { revision: number }).revision).toBe(0);
  await daemon.server.runtime.supervisor(anchorTaskId).graphControl({ graphId: taskId, action: 'stop' });
  await daemon.server.runtime.host.drive();
  await daemon.server.runtime.supervisor(anchorTaskId).graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Unavailable preference', protocols: {},
    nodes: { waiting: { recipe: 'coder@1', model: 'unavailable', task: 'Use a configured fallback when started', inputs: {}, outputs: {}, submission: {} } }, modules: {}, edges: {} }) });
  const saved = await api.post('/api/config', { expectedRevision: 0, document });
  expect(saved.status).toBe(200);
  expect((await (await api.get('/api/config')).json() as { revision: number }).revision).toBe(1);

}, 60_000);

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
  const daemon = await startGraphDaemon({
    configPath: path, stateDir: join(dir, 'state'), webDir, port: 0, mode: 'view',
    env: { HOME: dir, GRAPH_ALPHA_KEY: SECRET, GRAPH_BETA_KEY: SECRET }, log: () => undefined,
  });
  cleanup.push(() => daemon.close().catch(() => undefined));
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
  const daemon = await startGraphDaemon({
    configPath: path, stateDir: join(dir, 'state'), webDir, port: 0, mode: 'view',
    env: { HOME: dir, GRAPH_SYNTH_KEY: SECRET, GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY: SECRET }, log: () => undefined,
  });
  cleanup.push(() => daemon.close().catch(() => undefined));
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
  const daemon = await startGraphDaemon({
    configPath: path, stateDir: join(dir, 'state'), webDir, port: 0, mode: 'view',
    env: { HOME: dir, GRAPH_SYNTH_KEY: SECRET }, log: () => undefined,
  });
  cleanup.push(() => daemon.close().catch(() => undefined));
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

test('a supported platform offers an editable account name', async () => {
  const dir = await temp('account-name');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl, {
    credentials: { 'opencode-go-3': { platform: 'opencode-go', secretRef: 'GRAPH_OPENCODE_GO_ACCOUNT_3', displayName: '账户 2' } },
  });
  const daemon = await start(dir, path);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/models`);
  await page.getByTestId('settings-page').waitFor();
  await openModelEditor(page);

  // The vendor card lives in the independent 模型 tab.
  await page.getByTestId('provider-platform-opencode-go').click();
  const name = page.getByTestId('provider-label');
  await name.waitFor();
  // A supported platform is named by its label, and the operator may rename it.
  expect(await name.inputValue()).toBe('OpenCode Go');
  expect(await name.isEditable()).toBe(true);

  // Switching the credential id to an account shows that account's own name and
  // variable, so an existing account can be renamed instead of silently keeping
  // the platform's credential in the form.
  await page.getByTestId('provider-credentialId').fill('opencode-go-3');
  await expect.poll(async () => page.getByTestId('provider-credentialRef').inputValue(), { timeout: 10_000 }).toBe('GRAPH_OPENCODE_GO_ACCOUNT_3');
  expect(await name.inputValue()).toBe('账户 2');

  // And the operator may overwrite it.
  await name.fill('账户 2 · 工作');
  expect(await name.inputValue()).toBe('账户 2 · 工作');
}, 60_000);
