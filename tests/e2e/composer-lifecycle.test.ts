import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

let webDir: string;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-composer-lifecycle-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
afterAll(async () => { await rm(webDir, { recursive: true, force: true }); });

async function fixture(plans: ResponsePlan[], finiteBudget = false, pauseResponse?: Promise<void>, browserOptions: { args?: string[]; suggestionPlans?: ResponsePlan[]; messageResponse?: Promise<void>; steerResponse?: Promise<void>; initiallyDrive?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-composer-lifecycle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const suggestion = browserOptions.suggestionPlans ? await openaiServer(browserOptions.suggestionPlans) : undefined;
  if (suggestion) cleanup.push(() => suggestion.close());
  const options = {
    stateDir: join(root, 'state'), catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') }, projects: [{ id: 'alpha', root }], webDir, autoDrive: true,
    ...(finiteBudget ? { limits: { defaultBudgetTokens: 20_000_000 } } : {}),
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'high' as const, api: 'openai-completions' as const,
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }, ...(suggestion ? [{ id: 'cheap', provider: suggestion.model.provider, grade: 'low' as const, api: 'openai-completions' as const, baseUrl: suggestion.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }] : [])], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  };
  let server = await openGraphServer({ ...options, autoDrive: browserOptions.initiallyDrive !== false });
  server.runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'lifecycle-master');
  cleanup.push(() => server.close());
  let browserUrl = server.url;
  if (pauseResponse || browserOptions.messageResponse || browserOptions.steerResponse) {
    // Delay delivery of a genuine application response at the network boundary.
    // No owner DTO or pause transition is supplied by this transport proxy.
    const proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream = await fetch(`${server.url}${request.url}`, {
        method: request.method ?? 'GET', headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      if (request.url?.endsWith('/pause')) await pauseResponse;
      if (request.url?.endsWith('/messages') && request.method === 'POST') await browserOptions.messageResponse;
      if (request.url?.endsWith('/steer') && request.method === 'POST') await browserOptions.steerResponse;
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (!response.destroyed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            response.write(chunk.value);
          }
        } catch (error) {
          if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error)));
        } finally { reader.releaseLock(); }
      }
      response.end();
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    browserUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    cleanup.push(async () => { proxy.closeAllConnections(); await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); });
  }
  const browser = await chromium.launch({ headless: true, ...(browserOptions.args ? { args: browserOptions.args } : {}) });
  cleanup.push(() => browser.close());
  const context = await browser.newContext({ extraHTTPHeaders: { origin: browserUrl } });
  const page = await context.newPage();
  await page.request.get(browserUrl);
  async function post(path: string, data: Record<string, unknown> = {}) {
    const response = await page.request.post(`${browserUrl}${path}`, { data: { requestId: crypto.randomUUID(), ...data } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  async function view(id: string) { return (await page.request.get(`${browserUrl}/api/conversations/${id}`)).json(); }
  async function events(id: string) { return (await page.request.get(`${browserUrl}/api/conversations/${id}/events?limit=500`)).json() as Promise<{ type: string; data: Record<string, unknown> }[]>; }
  async function open(id: string) { await page.goto(`${browserUrl}/#/conversations/${id}`); await page.waitForURL(`${browserUrl}/#/conversations/${id}`); await page.locator('[data-testid="conversation"]:visible').getByTestId('chat-input').waitFor(); }
  async function answered(id: string, count: number) {
    await expect.poll(async () => (await view(id)).messages.filter((message: { role: string }) => message.role === 'assistant').length, { timeout: 30_000 }).toBe(count);
  }
  return { root, get url() { return browserUrl; }, page, provider, suggestion, post, view, events, open, answered, get runtime() { return server.runtime; }, async restart(restoredBinding?: { targetTaskId: string; sourceTaskId: string }) {
    await server.close();
    if (restoredBinding) {
      // External restore input changes only a current binding. Every instance,
      // invocation, receipt and row order came from the closed real producer.
      const snapshot = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
      try {
        const binding = snapshot.prepare("SELECT instance_id FROM nodes WHERE task_id=? AND id='master'");
        const source = binding.get(restoredBinding.sourceTaskId) as { instance_id: string };
        const target = binding.get(restoredBinding.targetTaskId) as { instance_id: string };
        expect(source.instance_id).toBeTruthy(); expect(target.instance_id).toBeTruthy();
        // Two independently produced instances remain uniquely bound. The
        // external restore input exchanges bindings without touching history.
        snapshot.exec('BEGIN');
        try {
          const update = snapshot.prepare("UPDATE nodes SET instance_id=? WHERE task_id=? AND id='master'");
          expect(update.run(null, restoredBinding.targetTaskId).changes).toBe(1);
          expect(update.run(target.instance_id, restoredBinding.sourceTaskId).changes).toBe(1);
          expect(update.run(source.instance_id, restoredBinding.targetTaskId).changes).toBe(1);
          snapshot.exec('COMMIT');
        } catch (error) { snapshot.exec('ROLLBACK'); throw error; }
      } finally { snapshot.close(); }
    }
    server = await openGraphServer(options);
    if (!pauseResponse && !browserOptions.messageResponse && !browserOptions.steerResponse) browserUrl = server.url;
    await context.setExtraHTTPHeaders({ origin: browserUrl });
    await page.request.get(browserUrl);
  } };
}

const usage = (input: number, cached: number): NonNullable<ResponsePlan['usage']> => ({ prompt_tokens: input, completion_tokens: 2, prompt_tokens_details: { cached_tokens: cached } });

test('recorded context and cache totals survive zero usage, another conversation and a server restart', async () => {
  const f = await fixture([
    { text: 'First recorded answer', usage: usage(100, 60) },
    { text: 'Zero usage answer', usage: usage(0, 0) },
    { text: 'Second zero usage answer', usage: usage(0, 0) },
    { text: 'Another conversation answer', usage: usage(900, 0) },
    { text: 'Latest real answer', usage: usage(200, 50) },
    { text: 'No measured input answer', usage: usage(0, 0) },
  ]);
  const { conversationId: id } = await f.post('/api/conversations', { text: 'First request' });
  await f.open(id); await f.answered(id, 1);
  expect((await f.view(id)).telemetry).toMatchObject({ contextTokens: 100, cachedInput: 60, cacheInput: 100, contextLimit: 32_000 });
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('telemetry-context').innerText()).toContain('100 / 32,000');
  await f.post(`/api/conversations/${id}/messages`, { text: 'Zero request' }); await f.answered(id, 2);
  await f.post(`/api/conversations/${id}/messages`, { text: 'Second zero request' }); await f.answered(id, 3);
  expect((await f.view(id)).telemetry).toMatchObject({ contextTokens: 100, cachedInput: 60, cacheInput: 100 });
  const { conversationId: other } = await f.post('/api/conversations', { text: 'Other request' }); await f.answered(other, 1);
  expect((await f.view(id)).telemetry.contextTokens).toBe(100);
  await f.restart(); await f.open(id);
  expect((await f.view(id)).telemetry).toMatchObject({ contextTokens: 100, cachedInput: 60, cacheInput: 100 });
  await f.post(`/api/conversations/${id}/messages`, { text: 'Latest request' }); await f.answered(id, 4);
  expect((await f.view(id)).telemetry).toMatchObject({ contextTokens: 200, cachedInput: 110, cacheInput: 300 });
  expect((await f.view(id)).telemetry.cacheHitRate).toBeCloseTo(110 / 300, 6);
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('telemetry-context').innerText()).toContain('200 / 32,000');
  const { conversationId: empty } = await f.post('/api/conversations', { text: 'No measured input' });
  await f.open(empty); await f.answered(empty, 1);
  expect((await f.view(empty)).telemetry.contextTokens).toBeNull();
}, 120_000);

test('paused queues cancel individually and resume through one composer action while conversation drafts stay isolated', async () => {
  const f = await fixture([{ text: 'Initial answer' }, { text: 'Foreign conversation answer' }, { text: 'Kept queue answer' }, { text: 'Typed resumed answer' }]);
  const { conversationId: id } = await f.post('/api/conversations', { text: 'First question' });
  await f.open(id); await f.answered(id, 1);
  const input = f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-input');
  const button = f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send');
  await expect.poll(() => button.isDisabled()).toBe(true);
  await f.post(`/api/conversations/${id}/pause`); await f.page.reload();
  await expect.poll(() => button.getAttribute('data-mode')).toBe('resume');
  expect(await f.page.getByTestId('conversation-paused-notice').count()).toBe(1);
  expect(await f.page.locator('[data-testid="conversation-pause"], [data-testid="conversation-resume"]').count()).toBe(0);
  expect(await f.page.locator('#conversation-toolbar').count()).toBe(1);
  expect(await f.page.locator('#conversation-toolbar').getByRole('button', { name: /暂停主 Agent|继续对话|继续主 Agent/ }).count()).toBe(0);
  expect(await f.page.getByRole('button', { name: '继续对话；输入内容时发送并继续', exact: true }).count()).toBe(1);
  const removed = await f.post(`/api/conversations/${id}/messages`, { text: 'Remove queue item' });
  await f.post(`/api/conversations/${id}/messages`, { text: 'Keep queue item' });
  await expect.poll(() => f.page.getByTestId('queued-message').count()).toBe(2);
  await f.page.getByTestId('queued-message').filter({ hasText: 'Remove queue item' }).getByTestId('queued-message-cancel').click();
  await expect.poll(() => f.page.getByTestId('queued-message').count()).toBe(1);
  expect(await f.page.getByTestId('queued-message').innerText()).toContain('Keep queue item');
  const replayId = crypto.randomUUID();
  const cancel = `/api/conversations/${id}/messages/${removed.messageId}/cancel`;
  const receipt = await f.post(cancel, { requestId: replayId });
  expect(await f.post(cancel, { requestId: replayId })).toEqual(receipt);
  expect(await f.post(`/api/conversations/${id}/messages/missing/cancel`)).toMatchObject({ cancelled: false, state: 'missing' });
  const { conversationId: foreign } = await f.post('/api/conversations', { text: 'Foreign queue' });
  await f.answered(foreign, 1);
  expect(await f.post(`/api/conversations/${foreign}/messages/${removed.messageId}/cancel`)).toMatchObject({ cancelled: false, state: 'missing' });
  await expect.poll(() => button.getAttribute('data-mode')).toBe('send');
  await button.click(); await f.answered(id, 2);
  await expect.poll(() => f.page.getByTestId('queued-message').count()).toBe(0);
  expect(await f.page.getByTestId('message-user').allTextContents()).not.toEqual(expect.arrayContaining([expect.stringContaining('Remove queue item')]));
  await f.post(`/api/conversations/${id}/pause`); await f.page.reload();
  await input.fill('Typed resumed question');
  await expect.poll(() => button.getAttribute('data-mode')).toBe('send');
  await button.click(); await f.answered(id, 3);
  expect((await f.view(id)).paused).toBe(false);
  await input.fill('Unsent isolated draft');
  await f.page.reload();
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.value)).toBe('Unsent isolated draft');
  await f.open(foreign);
  expect(await input.evaluate((element: HTMLTextAreaElement) => element.value)).toBe('');
  await f.open(id);
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.value)).toBe('Unsent isolated draft');
  await input.fill(''); await f.page.reload();
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.value)).toBe('');
}, 120_000);

test('a full browser storage quota does not prevent editing or sending a conversation message', async () => {
  const f = await fixture([{ text: 'Initial storage answer' }, { text: 'Sent despite exhausted storage' }]);
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Storage preparation' });
  await f.open(id); await f.answered(id, 1);
  // Exhaust the browser's real storage implementation, without replacing its
  // methods or the application draft owner with a mock.
  const exhausted = await f.page.evaluate(() => {
    const block = 'x'.repeat(64 * 1024);
    try {
      for (let index = 0; index < 1000; index++) localStorage.setItem(`quota-fixture-${index}`, block);
      return false;
    } catch (error) { return error instanceof DOMException && error.name === 'QuotaExceededError'; }
  });
  expect(exhausted).toBe(true);
  const input = f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-input');
  await input.fill('The quota must not stop this message');
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.value)).toBe('The quota must not stop this message');
  const send = f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send');
  // A durable answer may appear before the operation has settled. The same
  // button still pauses at that moment; wait for its actual send state.
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  await expect.poll(() => send.isDisabled()).toBe(false);
  const response = f.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/conversations/${id}/messages`));
  await send.click();
  const accepted = await response;
  expect(accepted.ok(), await accepted.text()).toBe(true);
  await expect.poll(() => f.provider.requests.length, { timeout: 30_000 }).toBe(2);
  await f.answered(id, 2);
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.value)).toBe('');
  expect((await f.view(id)).messages.filter((message: { role: string; text: string }) => message.role === 'user').map((message: { text: string }) => message.text)).toEqual(['Storage preparation', 'The quota must not stop this message']);
}, 90_000);

test('an externally restored current binding cannot erase genuine older master invocations or absorb another instance usage', async () => {
  const f = await fixture([
    { text: 'Older context recorded', usage: usage(100, 60) },
    { text: 'Latest context recorded', usage: usage(200, 50) },
    { text: 'Zero usage tail', usage: usage(0, 0) },
    { text: 'Missing usage tail', usage: null },
    { text: 'Other instance context', usage: usage(900, 800) },
  ], true);
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Produce older history' });
  await f.open(id); await f.answered(id, 1);
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send').getAttribute('data-mode')).toBe('send');
  await f.post(`/api/conversations/${id}/messages`, { text: 'Produce latest measured history' }); await f.answered(id, 2);
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send').getAttribute('data-mode')).toBe('send');
  await f.post(`/api/conversations/${id}/messages`, { text: 'Produce zero tail' }); await f.answered(id, 3);
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send').getAttribute('data-mode')).toBe('send');
  await f.post(`/api/conversations/${id}/messages`, { text: 'Produce unknown tail' });
  await expect.poll(async () => (await f.view(id)).questions.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const { conversationId: other } = await f.post('/api/conversations', { text: 'Produce legitimate other instance' });
  await f.open(other); await f.answered(other, 1);
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send').getAttribute('data-mode')).toBe('send');
  const targetTaskId = (await f.view(id)).anchorTaskId;
  const sourceTaskId = (await f.view(other)).anchorTaskId;
  expect(f.provider.requests).toHaveLength(5);
  await f.restart({ targetTaskId, sourceTaskId });
  await f.open(id);
  const restored = await f.view(id);
  expect(restored.telemetry).toMatchObject({ contextTokens: 200, cachedInput: 110, cacheInput: 300 });
  expect(restored.telemetry.cacheHitRate).toBeCloseTo(110 / 300, 6);
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('telemetry-context').innerText()).toContain('200 / 32,000');
  expect((await f.view(other)).telemetry).toMatchObject({ contextTokens: 900, cachedInput: 800, cacheInput: 900 });
  expect(f.provider.requests).toHaveLength(5);
}, 120_000);

test('real worker usage in a conversation graph cannot change its master context or cached input', async () => {
  const f = await fixture([
    { text: 'Master context recorded', usage: usage(100, 60) },
    { text: 'Worker used a larger context', usage: usage(1200, 1000) },
  ]);
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Coordinate a worker', projectId: 'alpha' });
  await f.open(id); await f.answered(id, 1);
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send').getAttribute('data-mode')).toBe('send');
  f.runtime.catalog.publishDefinition('context-worker', { recommendedGrade: 'high' }, 'context-worker');
  const main = f.runtime.supervisor((await f.view(id)).anchorTaskId);
  const { graphId } = await main.graphCreate({ definition: {
    schemaVersion: 2, name: 'Context isolation worker', protocols: { data: { type: 'object' } },
    nodes: { worker: { recipe: 'context-worker@1', model: 'local', task: 'Acknowledge the work', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} } },
    modules: {}, edges: {}, inputs: { job: { to: 'worker.job', protocol: 'data' } }, outputs: {},
  } }) as { graphId: string };
  await main.graphSend({ graphId, input: 'job', value: { work: 'Observe independent worker usage' } });
  await expect.poll(async () => {
    const view = await main.graphInspect({ graphId, query: 'executions' }) as { items: { state: string }[] };
    return view.items.filter(item => item.state === 'completed').length;
  }, { timeout: 30_000 }).toBe(1);
  expect(f.provider.requests).toHaveLength(2);
  expect((await f.view(id)).telemetry).toMatchObject({ contextTokens: 100, cachedInput: 60, cacheInput: 100 });
  await f.page.reload();
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('telemetry-context').innerText()).toContain('100 / 32,000');
  await main.graphControl({ graphId, action: 'stop' });
}, 90_000);

test('a finite-budget conversation preserves its last context when the provider omits usage and the turn requires reconciliation', async () => {
  const f = await fixture([
    { text: 'Measured context answer', usage: usage(100, 60) },
    { text: 'Unknown usage answer', usage: null },
  ], true);
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Measured first turn' });
  await f.open(id); await f.answered(id, 1);
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send').getAttribute('data-mode')).toBe('send');
  await f.post(`/api/conversations/${id}/messages`, { text: 'Provider omits the usage evidence' });
  await expect.poll(async () => (await f.view(id)).questions.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(f.provider.requests).toHaveLength(2);
  expect((await f.view(id)).telemetry).toMatchObject({ contextTokens: 100, cachedInput: 60, cacheInput: 100 });
  await f.restart(); await f.open(id);
  expect((await f.view(id)).telemetry).toMatchObject({ contextTokens: 100, cachedInput: 60, cacheInput: 100 });
  await expect.poll(() => f.page.locator('[data-testid="conversation"]:visible').getByTestId('telemetry-context').innerText()).toContain('100 / 32,000');
}, 90_000);

test('an active composer stays a pause action with typed and queued input, and a real in-flight pause disables its control', async () => {
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let finishModel!: () => void; const model = new Promise<void>(resolve => { finishModel = resolve; });
  let finishPause!: () => void; const pausedResponse = new Promise<void>(resolve => { finishPause = resolve; });
  const f = await fixture([{ text: 'Held active answer', beforeReply: async () => { enter(); await model; } }], false, pausedResponse);
  cleanup.push(async () => { finishModel(); finishPause(); });
  const { conversationId: id } = await f.post('/api/conversations', { text: 'A genuinely active turn' });
  await entered; await f.open(id);
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  const send = conversation.getByTestId('chat-send');
  const input = conversation.getByTestId('chat-input');
  await expect.poll(() => send.getAttribute('data-mode')).toBe('pause');
  await input.fill('An unsent draft during the active turn');
  await f.post(`/api/conversations/${id}/messages`, { text: 'A queued message during the active turn' });
  await expect.poll(() => conversation.getByTestId('queued-message').count()).toBe(1);
  expect(await send.getAttribute('data-mode')).toBe('pause');
  const pauseResponse = f.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/conversations/${id}/pause`));
  await send.click();
  await expect.poll(() => send.getAttribute('data-mode')).toBe('pending');
  expect(await send.isDisabled()).toBe(true);
  await expect.poll(async () => (await f.view(id)).paused).toBe(true);
  expect((await f.view(id)).messages.filter((message: { role: string }) => message.role === 'user').map((message: { text: string }) => message.text)).toEqual(['A genuinely active turn', 'A queued message during the active turn']);
  finishPause();
  const accepted = await pauseResponse;
  expect(accepted.ok(), await accepted.text()).toBe(true);
  await expect.poll(() => conversation.getByTestId('conversation-paused-notice').innerText()).toContain('当前工具调用收尾后停下');
  expect(await conversation.getByTestId('conversation-paused-notice').innerText()).toContain('不再发起新的模型请求');
  expect(await conversation.getByTestId('conversation-paused-notice').innerText()).toContain('接着跑被停下的那个回合');
  expect(f.provider.requests).toHaveLength(1);
  finishModel();
}, 90_000);

test('opening a real long conversation jumps to its newest answer once and later arrivals do not yank a reader', async () => {
  const history = Array.from({ length: 120 }, (_, index) => `History paragraph ${index}: retained source text.\n\n`).join('');
  const f = await fixture([{ text: history }, { text: 'A later answer while reading above' }]);
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Create readable history' });
  await f.answered(id, 1); await f.open(id);
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  const thread = conversation.locator('.conversation-thread');
  await expect.poll(() => thread.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1000);
  await expect.poll(() => thread.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(12);
  await thread.hover(); await f.page.mouse.wheel(0, -1000);
  await expect.poll(() => thread.getAttribute('data-pinned')).toBe('false');
  const position = await thread.evaluate(element => element.scrollTop);
  await f.post(`/api/conversations/${id}/messages`, { text: 'Append while I am reading history' });
  await f.answered(id, 2);
  // Offscreen history uses content-visibility:auto. textContent verifies the
  // appended DOM without forcing layout or scrolling the reader to the tail.
  await expect.poll(() => conversation.getByTestId('message-assistant').last().textContent()).toContain('A later answer while reading above');
  expect(Math.abs(await thread.evaluate(element => element.scrollTop) - position)).toBeLessThan(5);
  expect(await thread.getAttribute('data-pinned')).toBe('false');
}, 90_000);


test('a genuine cheaper-model suggestion stays opt-in and the enabled empty composer sends its exact next prompt', async () => {
  const prompt = 'Check the final independent contract.';
  const f = await fixture([{ text: '**Initial preference answer**' }, { text: 'The suggested work is done.' }], false, undefined, {
    suggestionPlans: [{ text: prompt }, { text: '没有建议' }],
  });
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Generate a next step' });
  await f.open(id); await f.answered(id, 1);
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  const input = conversation.getByTestId('chat-input');
  const send = conversation.getByTestId('chat-send');
  await expect.poll(async () => (await f.view(id)).messages.find((message: { role: string }) => message.role === 'assistant')?.data?.suggestedPrompt).toBe(prompt);
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  expect(await input.getAttribute('data-suggestion')).toBe('');
  expect(await send.isDisabled()).toBe(true);
  expect(await conversation.getByTestId('message-assistant').locator('strong').innerText()).toBe('Initial preference answer');
  await f.page.getByTestId('rail-settings').click();
  const candidate = f.page.getByTestId('pref-candidate-prompt');
  const markdown = f.page.getByTestId('pref-markdown');
  expect(await candidate.isChecked()).toBe(false);
  expect(await markdown.isChecked()).toBe(true);
  // An externally restored browser preference store is input to the reader,
  // not a replacement for the application's real storage methods.
  await f.page.evaluate(() => {
    localStorage.setItem('graph-pref-markdown-rendering', 'yes');
    localStorage.setItem('graph-pref-candidate-prompt', '1');
  });
  await f.page.reload();
  expect(await candidate.isChecked()).toBe(false);
  expect(await markdown.isChecked()).toBe(true);
  await candidate.check(); await markdown.uncheck();
  expect(await f.page.evaluate(() => ({ markdown: localStorage.getItem('graph-pref-markdown-rendering'), candidate: localStorage.getItem('graph-pref-candidate-prompt') }))).toEqual({ markdown: 'false', candidate: 'true' });
  await f.page.reload();
  expect(await candidate.isChecked()).toBe(true);
  expect(await markdown.isChecked()).toBe(false);
  await f.open(id);
  await expect.poll(() => input.getAttribute('data-suggestion')).toBe(prompt);
  expect(await send.isDisabled()).toBe(false);
  expect(await conversation.getByTestId('message-assistant').locator('strong').count()).toBe(0);
  expect(await conversation.getByTestId('message-assistant').innerText()).toContain('**Initial preference answer**');
  const accepted = f.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/conversations/${id}/messages`));
  await send.click();
  const response = await accepted;
  expect(response.request().postDataJSON()).toMatchObject({ text: prompt, attachments: [] });
  expect(response.ok(), await response.text()).toBe(true);
  await f.answered(id, 2);
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  expect((await f.view(id)).messages.filter((message: { role: string }) => message.role === 'user').map((message: { text: string }) => message.text)).toEqual(['Generate a next step', prompt]);
  expect(f.provider.requests).toHaveLength(2);
  expect(f.suggestion!.requests).toHaveLength(2);
  const decisions = (await f.events(id)).filter(event => event.type === 'prompt_suggestion.decided');
  expect(decisions.map(event => event.data)).toMatchObject([
    { model: 'cheap', asked: true, stopReason: 'stop', error: null, suggestion: prompt },
    { model: 'cheap', asked: true, stopReason: 'stop', error: null, suggestion: '' },
  ]);
  await expect.poll(() => input.getAttribute('data-suggestion')).toBe('');
  expect(await conversation.getByTestId('queued-message').count()).toBe(0);
  expect(await send.isDisabled()).toBe(true);
  await f.page.getByTestId('rail-settings').click();
  await markdown.check(); await candidate.uncheck();
  await f.page.reload();
  expect(await markdown.isChecked()).toBe(true);
  expect(await candidate.isChecked()).toBe(false);
  expect(await f.page.evaluate(() => ({ markdown: localStorage.getItem('graph-pref-markdown-rendering'), candidate: localStorage.getItem('graph-pref-candidate-prompt') }))).toEqual({ markdown: 'true', candidate: 'false' });
  await f.open(id);
  expect(await conversation.getByTestId('message-assistant').first().locator('strong').innerText()).toBe('Initial preference answer');
}, 90_000);

test('Chromium with local storage disabled still reads, clears and sends drafts without losing the conversation', async () => {
  const f = await fixture([{ text: 'Storage-disabled initial answer' }, { text: 'Storage-disabled sent answer' }], false, undefined, { args: ['--disable-local-storage'] });
  const { conversationId: id } = await f.post('/api/conversations', { text: 'No local storage browser' });
  await f.open(id); await f.answered(id, 1);
  const storage = await f.page.evaluate(() => {
    try {
      const value = window.localStorage;
      if (!value) return 'absent';
      value.getItem('storage-capability-probe');
      return 'available';
    } catch (error) { return error instanceof DOMException ? error.name : String(error); }
  });
  expect(storage).toBe('absent');
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  const input = conversation.getByTestId('chat-input');
  const send = conversation.getByTestId('chat-send');
  expect(await input.evaluate((element: HTMLElement & { readonly value: string }) => element.value)).toBe('');
  await input.fill('Draft without browser storage');
  await input.fill('');
  await input.fill('Send without browser storage');
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  expect(await send.isDisabled()).toBe(false);
  await send.click(); await f.answered(id, 2);
  await expect.poll(() => input.evaluate((element: HTMLElement & { readonly value: string }) => element.value)).toBe('');
  expect((await f.view(id)).messages.filter((message: { role: string }) => message.role === 'user').map((message: { text: string }) => message.text)).toEqual(['No local storage browser', 'Send without browser storage']);
  await f.page.reload();
  await expect.poll(() => input.evaluate((element: HTMLElement & { readonly value: string }) => element.value)).toBe('');
  expect(f.provider.requests).toHaveLength(2);
}, 90_000);


test('a refused cheaper-model suggestion records the vendor failure while the completed main reply remains usable', async () => {
  const f = await fixture([{ text: 'Main work completed despite suggestion refusal.' }], false, undefined, {
    suggestionPlans: Array.from({ length: 6 }, () => ({ status: 401, error: 'SUGGESTION_CREDENTIAL_REFUSED', errorCode: 'invalid_api_key' })),
  });
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Keep the successful main result' });
  await f.open(id); await f.answered(id, 1);
  await expect.poll(async () => (await f.events(id)).filter(event => event.type === 'prompt_suggestion.decided').length).toBe(1);
  const decisions = (await f.events(id)).filter(event => event.type === 'prompt_suggestion.decided');
  expect(decisions[0]!.data).toMatchObject({ model: 'cheap', asked: true, suggestion: '' });
  expect(decisions[0]!.data.error).toMatch(/SUGGESTION_CREDENTIAL_REFUSED|401/);
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  await expect.poll(() => conversation.getByTestId('chat-send').getAttribute('data-mode')).toBe('send');
  await expect.poll(() => conversation.getByTestId('message-assistant').innerText()).toContain('Main work completed despite suggestion refusal.');
  expect(f.provider.requests).toHaveLength(1);
  expect(f.suggestion!.requests.length).toBeGreaterThan(0);
  expect(await conversation.getByTestId('chat-input').getAttribute('data-suggestion')).toBe('');
  await conversation.getByTestId('chat-input').fill('The main composer still accepts input');
  expect(await conversation.getByTestId('chat-send').isDisabled()).toBe(false);
}, 90_000);


test('a genuine message response in flight keeps another typed draft disabled after the model has already settled', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture([{ text: 'Initial sending answer' }, { text: 'Accepted message completed' }], false, undefined, { messageResponse: pending });
  cleanup.push(async () => { release(); });
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Prepare sending control' });
  await f.open(id); await f.answered(id, 1);
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  const input = conversation.getByTestId('chat-input');
  const send = conversation.getByTestId('chat-send');
  await input.fill('First accepted message');
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  expect(await send.isDisabled()).toBe(false);
  const accepted = f.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/conversations/${id}/messages`));
  await send.click();
  await f.answered(id, 2);
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  await input.fill('Second unsent draft');
  expect(await send.isDisabled()).toBe(true);
  expect((await f.view(id)).messages.filter((message: { role: string }) => message.role === 'user').map((message: { text: string }) => message.text)).toEqual(['Prepare sending control', 'First accepted message']);
  expect(f.provider.requests).toHaveLength(2);
  release();
  const response = await accepted;
  expect(response.ok(), await response.text()).toBe(true);
  await expect.poll(() => send.isDisabled()).toBe(false);
  expect(await input.evaluate((element: HTMLElement & { readonly value: string }) => element.value)).toBe('Second unsent draft');
  expect(f.provider.requests).toHaveLength(2);
}, 90_000);


test('real active queue interruption carries ordered replacement text in the same operation and disables another steer until its receipt arrives', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let releaseModel!: () => void; const heldModel = new Promise<void>(resolve => { releaseModel = resolve; });
  let releaseReceipt!: () => void; const heldReceipt = new Promise<void>(resolve => { releaseReceipt = resolve; });
  const f = await fixture([
    { text: 'The interrupted obsolete answer', beforeReply: async () => { entered(); await heldModel; } },
    { text: 'The replacement queue was answered together.' },
  ], false, undefined, { steerResponse: heldReceipt });
  cleanup.push(async () => { releaseModel(); releaseReceipt(); });
  const { conversationId: id } = await f.post('/api/conversations', { text: 'Start work that will be interrupted' });
  await started; await f.open(id);
  await f.post(`/api/conversations/${id}/messages`, { text: 'First replacement instruction' });
  await f.post(`/api/conversations/${id}/messages`, { text: 'Second replacement instruction' });
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  const input = conversation.getByTestId('chat-input');
  const send = conversation.getByTestId('chat-send');
  await expect.poll(() => conversation.getByTestId('queued-message').count()).toBe(2);
  expect(await send.getAttribute('data-mode')).toBe('pause');
  const receipt = f.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/conversations/${id}/steer`));
  // Cleanup can close a held genuine response after an earlier assertion fails.
  // Handle that pending rejection immediately while preserving the later await.
  void receipt.catch(() => undefined);
  await input.press('Enter');
  await expect.poll(async () => (await f.events(id)).filter(event => event.type === 'message.steered').length).toBe(1);
  releaseModel();
  await expect.poll(() => f.provider.requests.length, { timeout: 30_000 }).toBe(2);
  const replacement = f.provider.requests[1] as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
  const userTexts = replacement.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''));
  expect(userTexts).toContain('First replacement instruction\n\nSecond replacement instruction');
  await f.answered(id, 1);
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  await input.fill('A later unsent draft');
  expect(await send.isDisabled()).toBe(true);
  const view = await f.view(id);
  const users = view.messages.filter((message: { role: string }) => message.role === 'user');
  expect(users.map((message: { text: string; state: string }) => [message.text, message.state])).toEqual([
    ['Start work that will be interrupted', 'delivered'],
    ['First replacement instruction', 'delivered'],
    ['Second replacement instruction', 'delivered'],
  ]);
  expect(new Set(users.map((message: { operationId: string }) => message.operationId)).size).toBe(1);
  expect(users[0].operationId).toBeTruthy();
  expect(view.messages.filter((message: { role: string }) => message.role === 'assistant').map((message: { text: string }) => message.text)).toEqual(['The replacement queue was answered together.']);
  releaseReceipt();
  const response = await receipt;
  expect(response.ok(), await response.text()).toBe(true);
  expect(await response.json()).toMatchObject({ state: 'steered', steered: 2 });
  await expect.poll(() => send.isDisabled()).toBe(false);
  expect(await input.evaluate((element: HTMLElement & { readonly value: string }) => element.value)).toBe('A later unsent draft');
  expect(await conversation.getByTestId('queued-message').count()).toBe(0);
  expect(f.provider.requests).toHaveLength(2);
}, 90_000);

test('queued messages survive a real restart and receipt replay without merging FIFO turns or dispatching an archived conversation', async () => {
  let secondEntered!: () => void; const secondStarted = new Promise<void>(resolve => { secondEntered = resolve; });
  let releaseSecond!: () => void; const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const f = await fixture([
    { text: 'FIFO first answer' },
    { text: 'FIFO second answer', beforeReply: async () => { secondEntered(); await secondHeld; } },
    { text: 'FIFO third answer' },
  ], false, undefined, { initiallyDrive: false });
  cleanup.push(async () => { releaseSecond(); });
  const { conversationId: id, messageId: firstMessageId } = await f.post('/api/conversations', { text: 'FIFO first message' });
  const pending = await f.view(id);
  expect(pending.projectId).toBeNull(); expect(pending.tasks).toEqual([]);
  expect(pending.messages).toMatchObject([{ id: firstMessageId, role: 'user', text: 'FIFO first message', state: 'pending' }]);
  expect(pending.messages).toHaveLength(1);
  expect(await (await f.page.request.get(`${f.url}/api/tasks`)).json()).toEqual([]);
  expect(f.provider.requests).toHaveLength(0);
  // The actual first producer never drove dispatch. A fresh server must recover
  // its pending first message, not merely a later explicitly paused queue.
  await f.restart(); await f.open(id); await f.answered(id, 1);
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  const send = conversation.getByTestId('chat-send');
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  expect((await f.view(id)).projectId).toBeNull();
  expect((await f.view(id)).tasks).toEqual([]);
  const firstAnswer = await f.view(id);
  expect(firstAnswer.master?.status).toBe('succeeded');
  expect(firstAnswer.requirementVersion).toBe(1);
  expect(JSON.stringify(f.provider.requests[0])).toContain(`[${firstMessageId}] (v1) FIFO first message`);
  expect(firstAnswer.messages.map((message: { role: string; state: string }) => [message.role, message.state])).toEqual([['user', 'delivered'], ['assistant', 'done']]);
  expect(await (await f.page.request.get(`${f.url}/api/tasks`)).json()).toEqual([]);
  expect(await f.runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(f.provider.requests).toHaveLength(1);
  await f.post(`/api/conversations/${id}/pause`);
  const replay = crypto.randomUUID();
  const accepted = await f.post(`/api/conversations/${id}/messages`, { text: 'FIFO second message', requestId: replay });
  expect(await f.post(`/api/conversations/${id}/messages`, { text: 'FIFO second message', requestId: replay })).toEqual(accepted);
  const conflict = await f.page.request.post(`${f.url}/api/conversations/${id}/messages`, { data: { text: 'Different receipt content', requestId: replay } });
  expect(conflict.status()).toBe(400);
  expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
  const thirdAccepted = await f.post(`/api/conversations/${id}/messages`, { text: 'FIFO third message' });
  const archiveReceipt = await f.post(`/api/conversations/${id}/archive`);
  expect(archiveReceipt).toMatchObject({ archived: true, conversationId: id });
  expect(Number.isFinite(archiveReceipt.archivedAt)).toBe(true);
  expect(archiveReceipt.archivedAt).toBeGreaterThan(0);
  await f.restart(); await f.open(id);
  expect((await f.view(id)).archived).toBe(true);
  expect((await f.view(id)).paused).toBe(true);
  expect(f.provider.requests).toHaveLength(1);
  expect((await f.view(id)).messages.filter((message: { role: string }) => message.role === 'user').map((message: { text: string; state: string }) => [message.text, message.state])).toEqual([
    ['FIFO first message', 'delivered'], ['FIFO second message', 'queued'], ['FIFO third message', 'queued'],
  ]);
  // Remove the pause guard first: archive alone must still prevent admission.
  await f.post(`/api/conversations/${id}/resume`);
  expect((await f.view(id)).paused).toBe(false);
  expect(await f.runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(f.provider.requests).toHaveLength(1);
  expect(await (await f.page.request.get(`${f.url}/api/conversations`)).json()).toEqual([]);
  expect(await (await f.page.request.get(`${f.url}/api/conversations?archived=true`)).json()).toMatchObject([{ id, archivedAt: archiveReceipt.archivedAt }]);
  expect((await f.view(id)).messages.filter((message: { role: string }) => message.role === 'user').map((message: { text: string }) => message.text)).toEqual(['FIFO first message', 'FIFO second message', 'FIFO third message']);
  expect(await f.post(`/api/conversations/${id}/unarchive`)).toMatchObject({ archived: false, archivedAt: null });
  expect((await (await f.page.request.get(`${f.url}/api/conversations`)).json()).map((item: { id: string }) => item.id)).toEqual([id]);
  expect(await (await f.page.request.get(`${f.url}/api/conversations?archived=true`)).json()).toEqual([]);
  await secondStarted;
  const middle = await f.view(id);
  // Transcript grouping uses delivery/turn ordinals; assert each message's
  // admission state by its stable identity and FIFO using queued inputs/wire.
  expect(Object.fromEntries(middle.messages.filter((message: { role: string }) => message.role === 'user').map((message: { id: string; state: string }) => [message.id, message.state]))).toEqual({
    [accepted.messageId]: 'delivered', [thirdAccepted.messageId]: 'queued',
    [firstMessageId]: 'delivered',
  });
  expect(middle.messages.filter((message: { state: string }) => message.state === 'queued').map((message: { id: string }) => message.id)).toEqual([thirdAccepted.messageId]);
  expect(f.provider.requests).toHaveLength(2);
  const second = f.provider.requests[1] as { messages: { role: string; content: unknown }[] };
  expect(JSON.stringify(second.messages)).toContain('FIFO second message');
  expect(JSON.stringify(second.messages)).not.toContain('FIFO third message');
  releaseSecond(); await f.answered(id, 3);
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  const final = await f.view(id);
  expect(final.messages.filter((message: { role: string }) => message.role === 'assistant').map((message: { text: string }) => message.text)).toEqual(['FIFO first answer', 'FIFO second answer', 'FIFO third answer']);
  const users = final.messages.filter((message: { role: string }) => message.role === 'user');
  expect(users.map((message: { state: string }) => message.state)).toEqual(['delivered', 'delivered', 'delivered']);
  expect(new Set(users.map((message: { operationId: string }) => message.operationId)).size).toBe(3);
  expect(f.provider.requests).toHaveLength(3);
  const thirdRequest = f.provider.requests[2] as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
  const latestUser = thirdRequest.messages.filter(message => message.role === 'user').at(-1)!;
  const thirdPrompt = typeof latestUser.content === 'string' ? latestUser.content : latestUser.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
  expect(thirdPrompt).toContain(`User messages:\n- [${thirdAccepted.messageId}] (v1) FIFO third message`);
  await f.page.reload();
  await expect.poll(() => conversation.getByTestId('message-assistant').count()).toBe(3);
  expect(f.provider.requests).toHaveLength(3);
}, 120_000);


test('real main provider prompts preserve attached message anchors and the available Agent recipe description', async () => {
  const f = await fixture([{ text: 'The supplied notes and recipe were received.' }, { text: 'The revised requirement and acceptance were received.' }]);
  const identity = join(f.root, 'capabilities', 'agent-md', 'coder-identity');
  await mkdir(identity, { recursive: true });
  await writeFile(join(identity, 'capability.json'), JSON.stringify({ id: 'coder-identity', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'Coder identity' }));
  await writeFile(join(identity, 'agent.md'), 'You are a coder.\n');
  await f.post('/api/catalog/refresh');
  await f.post('/api/catalog/combinations', { combination: {
    id: 'coder', name: 'Bob_coder', description: '默认主实现，承担功能开发、维护、修复和基础测试。', recommendedGrade: 'medium', review: false, tags: ['编码'],
    resources: [{ resourceId: 'coder-identity', version: '1.0.0', role: 'identity', required: true }],
  } });
  const created = await f.post('/api/conversations', { text: '请查看附件', attachments: [{ name: 'notes.md', type: 'text/markdown', size: 8, text: '# Notes\n' }] });
  await f.open(created.conversationId); await f.answered(created.conversationId, 1);
  expect(f.provider.requests).toHaveLength(1);
  const request = f.provider.requests[0] as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
  const prompt = request.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('')).join('\n');
  expect(prompt).toContain(`User messages:\n- [${created.messageId}] (v1) 请查看附件`);
  expect(prompt).toContain('Requirement version: 1');
  expect(prompt).toContain('Attachments supplied by the user');
  expect(prompt).toContain('notes.md (8 bytes, text/markdown)');
  expect(prompt).toContain('# Notes');
  expect(prompt).toContain('- Agent recipe coder (Bob_coder, medium, valid): 默认主实现，承担功能开发、维护、修复和基础测试。');
  const view = await f.view(created.conversationId);
  expect(view.messages.find((message: { id: string }) => message.id === created.messageId)).toMatchObject({ text: '请查看附件', data: { attachments: [{ name: 'notes.md', text: '# Notes\n' }] } });
  const send = f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-send');
  await expect.poll(() => send.getAttribute('data-mode')).toBe('send');
  await f.post(`/api/conversations/${created.conversationId}/pause`);
  await f.post(`/api/tasks/${view.anchorTaskId}/say`, { text: '先实现 A' });
  await f.post(`/api/tasks/${view.anchorTaskId}/say`, { text: '加入 B' });
  expect((await f.view(created.conversationId)).requirementVersion).toBe(3);
  await f.runtime.supervisor(view.anchorTaskId).propose({
    requirementVersion: 3, summary: '实现 A 与 B', acceptance: [{ id: 'a1', description: '两种行为都成立', checkNode: 'check' }],
    definition: { schemaVersion: 2, name: '实现 A 与 B', protocols: { data: { type: 'object' } }, nodes: {},
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
      edges: {}, inputs: {}, outputs: {}, acceptance: [{ id: 'a1', description: '两种行为都成立', kind: 'check', module: 'check' }],
    },
  }, crypto.randomUUID());
  const message = await f.post(`/api/conversations/${created.conversationId}/messages`, { text: '做这两件事' });
  await f.post(`/api/conversations/${created.conversationId}/resume`);
  await f.answered(created.conversationId, 2);
  expect(f.provider.requests).toHaveLength(2);
  const revised = f.provider.requests[1] as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
  const revisedPrompt = revised.messages.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : item.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('')).join('\n');
  expect(revisedPrompt).toContain('Requirement version: 3');
  expect(revisedPrompt).toContain(`User messages:\n- [${message.messageId}] (v3) 做这两件事`);
  expect(revisedPrompt).toContain('- a1 (check check): 两种行为都成立');
  expect(revisedPrompt).toContain('Summary: 实现 A 与 B');
}, 90_000);
