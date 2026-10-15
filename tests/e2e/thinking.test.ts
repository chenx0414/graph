import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('catalog thinking options survive config saves and clamp actual conversation requests', async () => {
  const vendor = await openaiServer(Array.from({ length: 16 }, () => ({ text: 'thinking selected' })));
  cleanup.push(() => vendor.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-thinking-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  const cases = [
    { id: 'grok', provider: 'grok', modelId: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'], requested: 'max', selected: 'xhigh' },
    { id: 'deepseek', provider: 'deepseek', modelId: 'deepseek-flash', levels: ['low', 'high', 'max'], requested: 'medium', selected: 'high' },
    { id: 'account', provider: 'opencode-go-3', modelId: 'deepseek-v4.1-flash', levels: ['low', 'high', 'max'], defaultThinkingLevel: 'xhigh', selected: 'max' },
    { id: 'bunny', provider: 'opencode-go-3', modelId: 'space-bunny-free', levels: ['low', 'medium', 'high', 'xhigh', 'max'], selected: 'xhigh' },
    { id: 'toggle', provider: 'opencode-go', modelId: 'mimo-v2.6-pro', levels: ['minimal', 'low', 'medium', 'high'], selected: 'medium' },
    { id: 'unknown', provider: 'no-such-provider', modelId: 'no-such-model', levels: ['minimal', 'low', 'medium', 'high'], defaultThinkingLevel: 'xhigh', selected: 'high' },
    { id: 'legacy', provider: 'grok', modelId: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'], reasoning: false, requested: 'off', selected: 'low' },
    { id: 'minimal', provider: 'grok', modelId: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'], requested: 'minimal', selected: 'low' },
    { id: 'default', provider: 'grok', modelId: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'], selected: 'high' },
    { id: 'single', provider: 'nano-gpt', modelId: 'openai/gpt-5-pro', levels: ['high'], selected: 'high' },
    { id: 'empty', provider: 'llmgateway-providers', modelId: 'novita/ling-3.0-flash', levels: [], selected: 'off' },
    { id: 'deepseek-off', provider: 'deepseek', modelId: 'deepseek-flash', levels: ['low', 'high', 'max'], requested: 'off', selected: 'low' },
    { id: 'deepseek-default', provider: 'deepseek', modelId: 'deepseek-flash', levels: ['low', 'high', 'max'], selected: 'high' },
  ];
  const entries = cases.map(row => ({ id: row.id, provider: row.provider, modelId: row.modelId, grade: 'high', api: 'openai-completions', baseUrl: vendor.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local', reasoning: row.reasoning ?? true, ...(row.defaultThinkingLevel ? { defaultThinkingLevel: row.defaultThinkingLevel } : {}) }));
  const configPath = join(root, 'graph.config.json');
  const document = { version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } }, models: { entries } };
  await writeFile(configPath, JSON.stringify(document));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true, env: { HOME: root, GRAPH_LOCAL_KEY: 'thinking-key' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const get = (path: string) => fetch(`${daemon.url}${path}`, { headers });
  const post = (path: string, body: unknown) => fetch(`${daemon.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect(await (await post('/api/config', { expectedRevision: 0, document })).json()).toMatchObject({ applied: true });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const ui = (id: string) => page.locator(`[data-testid="${id}"]:visible`);
  const pressStrength = async (key: string) => {
    await expect.poll(() => ui('thinking-slider').isEnabled()).toBe(true);
    await ui('thinking-slider').focus();
    await page.keyboard.press(key);
  };
  await page.goto(daemon.url);
  await ui('new-conversation-input').waitFor();
  await expect.poll(() => ui('telemetry-model').innerText()).toContain('grok');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('high');
  const settings = await (await get('/api/settings')).json();
  const config = await (await get('/api/config')).json();
  for (const row of cases) {
    for (const models of [settings.models, config.config.models.entries]) {
      const model = models.find((candidate: { id: string }) => candidate.id === row.id);
      expect(model.thinkingOptions).toEqual(row.levels.map(level => ({ level, label: level })));
    }
    const created = await (await post('/api/conversations', { text: `choose ${row.id}`, model: row.id, ...(row.requested ? { thinkingLevel: row.requested } : {}), requestId: `thinking-${row.id}` })).json();
    expect(created.conversationId).toBeTruthy();
    await expect.poll(async () => (await (await get(`/api/tasks/${created.taskId}`)).json()).invocations[0]?.cost, { timeout: 20_000 }).toEqual({ unknown: true });
    expect((await (await get(`/api/conversations/${created.conversationId}`)).json()).telemetry).toMatchObject({ model: row.id, thinkingLevel: row.selected });
    await page.goto(`${daemon.url}/#/conversations/${created.conversationId}`);
    await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe(row.selected);
    await ui('model-control').click();
    await ui('model-menu').waitFor();
    const slider = ui('thinking-slider');
    expect(await slider.getAttribute('data-levels')).toBe(row.levels.join(','));
    expect(await slider.getAttribute('max')).toBe(String(Math.max(0, row.levels.length - 1)));
    expect(await slider.isDisabled()).toBe(row.levels.length === 0);
    expect(await ui('thinking-labels').locator('span').allTextContents()).toEqual(row.levels);
    expect(await ui('thinking-current').innerText()).toBe(row.selected);
    if (row.levels.length === 0) expect(await ui('thinking-disabled').innerText()).toBe('该模型没有可选的思考强度档位');
    await page.keyboard.press('Escape');
    await ui('model-menu').waitFor({ state: 'hidden' });
    const sent = vendor.requests.find(request => {
      const body = request as { tools?: unknown[]; messages?: { role: string; content: unknown }[] };
      return Boolean(body.tools?.length) && body.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes(`choose ${row.id}`));
    });
    expect(sent, `Main model request for ${row.id}`).toMatchObject({ model: row.modelId });
    if (row.selected === 'off') expect(sent).not.toHaveProperty('reasoning_effort');
    else expect(sent).toMatchObject({ reasoning_effort: row.selected });
  }
  // Change a genuine persisted conversation through the same control the user sees.
  await ui('model-control').click();
  await ui('model-option-grok').click();
  await expect.poll(() => ui('telemetry-model').innerText()).toContain('grok');
  const slider = ui('thinking-slider');
  await pressStrength('End');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('xhigh');
  await ui('model-option-deepseek').click();
  await expect.poll(() => ui('telemetry-model').innerText()).toContain('deepseek');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('max');
  expect(await ui('thinking-labels').locator('span').allTextContents()).toEqual(['low', 'high', 'max']);
  await page.keyboard.press('Escape');
  await ui('chat-input').fill('ACTUAL_UI_THINKING_SELECTION');
  await ui('chat-send').click();
  await expect.poll(() => vendor.requests.find(request => {
    const body = request as { tools?: unknown[]; messages?: { role: string; content: unknown }[] };
    return Boolean(body.tools?.length) && body.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('ACTUAL_UI_THINKING_SELECTION'));
  }), { timeout: 20_000 }).toMatchObject({ model: 'deepseek-flash', reasoning_effort: 'max' });
  // Finish the previous genuine turn before changing the live model catalog.
  const savedConversationId = new URL(page.url()).hash.slice('#/conversations/'.length).split('?')[0]!;
  await expect.poll(async () => (await (await get(`/api/conversations/${savedConversationId}`)).json()).master?.status,
    { timeout: 20_000 }).toBe('succeeded');
  await ui('model-control').click();
  await ui('model-option-grok').click();
  await expect.poll(() => ui('telemetry-model').innerText()).toContain('grok');
  // Exercise the browser's stronger-neighbour fallback independently of the API clamp.
  await pressStrength('Home');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('low');
  await pressStrength('ArrowRight');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('medium');
  await ui('model-option-deepseek').click();
  await expect.poll(() => ui('telemetry-model').innerText()).toContain('deepseek');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('high');
  await ui('model-option-grok').click();
  await expect.poll(() => ui('telemetry-model').innerText()).toContain('grok');
  await pressStrength('End');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('xhigh');
  expect((await (await get(`/api/conversations/${savedConversationId}`)).json()).telemetry)
    .toMatchObject({ model: 'grok', thinkingLevel: 'xhigh' });
  await page.keyboard.press('Escape');
  // Keep the real connection identity while its configured upstream changes.
  // Existing conversation history keeps xhigh; the live catalog now only offers low/high/max.
  const changedDocument = {
    ...document,
    models: { entries: entries.map(entry => entry.id === 'grok'
      ? { ...entry, provider: 'deepseek', modelId: 'deepseek-flash' }
      : entry) },
  };
  expect(await (await post('/api/config', { expectedRevision: 1, document: changedDocument })).json())
    .toMatchObject({ applied: true });
  expect((await (await get(`/api/conversations/${savedConversationId}`)).json()).telemetry)
    .toMatchObject({ model: 'grok', thinkingLevel: 'xhigh' });
  await page.reload();
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('max');
  expect(await ui('telemetry-thinking').getAttribute('data-saved-level')).toBe('xhigh');
  await ui('model-control').click();
  expect(await ui('thinking-slider').getAttribute('data-levels')).toBe('low,high,max');
  expect(await ui('thinking-current').innerText()).toBe('max');
  expect(await ui('thinking-fallback').innerText()).toBe('已保存的 xhigh 不在该模型档位内，按 max 执行');
  // Choose an actual legal level through the control, then persist the strongest level.
  await pressStrength('Home');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('low');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-saved-level')).toBeNull();
  await expect.poll(() => ui('thinking-fallback').count()).toBe(0);
  await pressStrength('End');
  await expect.poll(() => ui('telemetry-thinking').getAttribute('data-level')).toBe('max');
  expect((await (await get(`/api/conversations/${savedConversationId}`)).json()).telemetry)
    .toMatchObject({ model: 'grok', thinkingLevel: 'max' });
  await page.keyboard.press('Escape');
  await ui('chat-input').fill('ACTUAL_SAVED_THINKING_REPAIRED');
  await ui('chat-send').click();
  await expect.poll(() => vendor.requests.find(request => {
    const body = request as { tools?: unknown[]; messages?: { role: string; content: unknown }[] };
    return Boolean(body.tools?.length) && body.messages?.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes('ACTUAL_SAVED_THINKING_REPAIRED'));
  }), { timeout: 20_000 }).toMatchObject({ model: 'deepseek-flash', reasoning_effort: 'max' });
  await expect.poll(async () => (await (await get(`/api/conversations/${savedConversationId}`)).json()).master?.status,
    { timeout: 20_000 }).toBe('succeeded');

}, 180_000);
