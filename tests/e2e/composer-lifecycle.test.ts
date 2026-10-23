import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cleanup, fixture, usage } from '../fixtures/composer-lifecycle.ts';

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
