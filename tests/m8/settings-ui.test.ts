import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';

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

async function configFile(dir: string, baseUrl: string) {
  const path = join(dir, 'graph.config.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    projects: [{ id: 'sample', root: dir }],
    models: { entries: [{ id: 'local', provider: 'stub', grade: 'medium', api: 'openai-completions', baseUrl, contextWindow: 2048, maxTokens: 128, credentialId: 'local' }] },
    credentials: { local: { secretRef: 'GRAPH_SYNTH_KEY' } },
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
  await page.goto(`${daemon.url}/#/settings`);
  await page.getByTestId('settings-page').waitFor();
  expect(await page.getByTestId('config-revision').innerText()).toBe('0');
  expect(await page.locator('body').innerText()).not.toContain(SECRET);
  expect(await page.getByTestId('theme-placeholder').isVisible()).toBe(true);
  expect(await page.getByTestId('theme-system').getAttribute('data-active')).toBe('true');
  await page.getByTestId('theme-dark').click();
  expect(await page.getByTestId('theme-dark').getAttribute('data-active')).toBe('true');
  await page.getByTestId('theme-system').click();
  const openPage = (label: string) => page.locator('.settings-nav-item').filter({ hasText: label }).click();

  await openPage('模型');
  expect(await page.locator('#settings-credentials').isVisible()).toBe(true);
  expect(await page.locator('#settings-models').isVisible()).toBe(true);
  expect(await page.locator('#settings-preferences').count()).toBe(0);
  expect(await page.locator('#settings-limits').isVisible()).toBe(true);
  expect(await page.getByTestId('setup').isVisible()).toBe(true);
  expect(await page.locator('#settings-project').count()).toBe(0);
  expect(await page.getByTestId('settings-save').count()).toBe(0);
  expect(await page.getByTestId('settings-reload').count()).toBe(0);
  expect(await page.getByTestId('settings-action-strip').count()).toBe(0);
  expect(await page.getByTestId('model-0-price').innerText()).toContain('价格未知');
  expect(await page.getByTestId('model-0-reasoning').isChecked()).toBe(true);
  expect(stub.requests).toHaveLength(0);

  await page.getByTestId('credential-add').click();
  await page.getByTestId('credential-1-id').fill('second');
  await page.getByTestId('credential-1-secretRef').fill('GRAPH_SYNTH_KEY_2');
  await page.locator('[data-testid="credential-row-1"] .credential-advanced summary').click();
  await page.getByTestId('credential-1-group').fill('group-1');
  await page.locator('[data-testid="credential-row-0"] .credential-advanced summary').click();
  await page.getByTestId('credential-0-group').fill('group-1');
  await page.getByTestId('model-add').click();
  await page.locator('[data-testid="model-row-1"] .model-advanced summary').click();
  await page.getByTestId('model-1-id').fill('second-model');
  await page.getByTestId('model-1-provider-manual').fill('stub-hi');
  await page.getByTestId('model-1-grade').selectOption('high');
  await page.getByTestId('model-1-credentialId').selectOption('second');
  await page.getByTestId('model-1-baseUrl').fill(stub.baseUrl);
  await page.getByTestId('model-1-context').fill('4096');
  await page.getByTestId('model-1-maxTokens').fill('256');
  await page.getByTestId('model-1-reasoning').uncheck();
  await page.getByTestId('limit-group-add').click();
  await page.getByTestId('limit-group-0').fill('4');
  await expect.poll(async () => (await (await api.get('/api/config')).json() as { revision: number }).revision, { timeout: 10_000 }).toBe(1);
  await page.getByTestId('config-status').waitFor();
  expect(await page.getByTestId('config-status').innerText()).toContain('已自动保存 revision 1');
  await openPage('常规');
  // Hot apply: the running revision advances without a restart prompt.
  expect(await page.getByTestId('effective-revision').innerText()).toContain('1');
  expect(await page.getByTestId('restart-required').count()).toBe(0);

  // Persistence across a browser reload.
  await page.reload();
  await page.getByTestId('settings-page').waitFor();
  await openPage('模型');
  await page.locator('[data-testid="model-row-1"] .model-advanced summary').click();
  expect(await page.getByTestId('model-1-id').inputValue()).toBe('second-model');
  expect(await page.getByTestId('model-1-reasoning').isChecked()).toBe(false);
  await page.locator('[data-testid="credential-row-1"] .credential-advanced summary').click();
  expect(await page.getByTestId('credential-1-group').inputValue()).toBe('group-1');
  expect(await page.getByTestId('credential-1-state').innerText()).toBe('缺失');
  expect(await page.getByTestId('limit-group-0').inputValue()).toBe('4');
  expect(await page.locator('body').innerText()).not.toContain(SECRET);

  // Persistence across a daemon restart on the same state and config.
  await daemon.close();
  const restarted = await start(dir, path, 0);
  const restartedApi = await session(restarted.url);
  const configText = await (await restartedApi.get('/api/config')).text();
  expect(JSON.parse(configText)).toMatchObject({ revision: 1, config: { projects: [{ id: 'sample' }] } });
  expect(configText).not.toContain(SECRET);
  expect(JSON.parse(configText).config.credentials.second.configured).toBe(false);
  expect(JSON.parse(configText).config.credentials.second.secretRef).toBe('GRAPH_SYNTH_KEY_2');
  expect(JSON.parse(configText).config.models.entries[1].reasoning).toBe(false);
  expect(JSON.parse(configText).config.limits.sharedGroups['group-1']).toBe(4);

  // The connection test only runs on an explicit click and reaches the right model and credential.
  await page.goto(`${restarted.url}/#/settings`);
  await page.getByTestId('settings-page').waitFor();
  await openPage('模型');
  await page.locator('[data-testid="model-row-0"] .model-advanced summary').click();
  expect(stub.requests).toHaveLength(0);
  await page.getByTestId('model-0-test').click();
  await page.getByTestId('connection-result-0').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="connection-result-0"]')?.textContent?.includes('连接成功'));
  expect(stub.requests).toHaveLength(1);
  expect(stub.requests[0]).toMatchObject({ model: 'local', authorization: `Bearer ${SECRET}`, path: '/v1/chat/completions' });

  // Invalid edits are refused with a field error and never replace the saved document.
  const before = await (await restartedApi.get('/api/config')).text();
  await page.locator('[data-testid="model-row-1"] .model-advanced summary').click();
  await page.getByTestId('model-1-id').fill('local');
  await page.getByTestId('config-error').waitFor({ timeout: 10_000 });
  expect(await page.getByTestId('config-error').innerText()).toContain('duplicate model');
  expect((await (await restartedApi.get('/api/config')).text())).toBe(before);
  await openPage('常规');
  expect(await page.getByTestId('config-revision').innerText()).toBe('1');
}, 120_000);

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
  expect(await toggle.evaluate(element => element.parentElement?.classList.contains('chat-composer-controls'))).toBe(true);
  expect(await toggle.getAttribute('aria-pressed')).toBe('false');
  expect(await toggle.innerText()).toContain('完全访问');
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.locator('.new-chat-composer .chat-composer-controls').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  await toggle.click();
  await expect.poll(async () => (await (await api.get('/api/config')).json() as { revision: number }).revision).toBe(1);
  await expect.poll(async () => toggle.getAttribute('aria-pressed')).toBe('true');
  const full = await (await api.get('/api/config')).json() as { config: { access: { mode: string; filesystem: { read: string } } } };
  expect(full.config.access).toMatchObject({ mode: 'full', filesystem: { read: 'host' } });

  await toggle.click();
  await expect.poll(async () => (await (await api.get('/api/config')).json() as { revision: number }).revision).toBe(2);
  await expect.poll(async () => toggle.getAttribute('aria-pressed')).toBe('false');
  const standard = await (await api.get('/api/config')).json() as { config: { access: { mode: string; filesystem: { read: string } } } };
  expect(standard.config.access).toMatchObject({ mode: 'standard', filesystem: { read: 'workspace-and-bound' } });

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
  const { taskId } = await daemon.server.runtime.user.begin({ projectId: 'sample', request: 'Keep binding', requestId: 'begin' });
  await daemon.server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Keep binding',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await daemon.server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  expect(daemon.server.runtime.modelsInUse()).toContain('local');
  const document = {
    version: 1, projects: [{ id: 'sample', root: dir }],
    models: { entries: [] }, credentials: { local: { secretRef: 'GRAPH_SYNTH_KEY' } }, limits: { credentials: { local: 1 } },
  };
  const refused = await api.post('/api/config', { expectedRevision: 0, document });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'config_in_use' });
  const view = await daemon.server.runtime.user.task(taskId).view();
  expect(view.nodes.find(node => node.id === 'work')?.selectedModel).toBe('local');
  expect((await (await api.get('/api/config')).json() as { revision: number }).revision).toBe(0);
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
