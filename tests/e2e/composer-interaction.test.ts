import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cleanup, fixture, usage } from '../fixtures/composer-lifecycle.ts';

test('an active composer stays a pause action with typed and queued input, and a real in-flight pause disables its control', async () => {
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let finishModel!: () => void; const model = new Promise<void>(resolve => { finishModel = resolve; });
  let finishPause!: () => void; const pausedResponse = new Promise<void>(resolve => { finishPause = resolve; });
  const f = await fixture([{ text: 'Held active answer', beforeReply: async () => { enter(); await model; } }], false, pausedResponse);
  cleanup.push(async () => { finishModel(); finishPause(); });
  const { conversationId: id } = await f.post('/api/conversations', { text: 'A genuinely active turn' });
  await entered; await f.open(id);
  const conversation = f.page.locator('[data-testid="conversation"]:visible');
  await expect.poll(() => conversation.getByTestId('message-user').count()).toBeGreaterThan(0);
  expect(await conversation.locator('.message-author').allInnerTexts(), 'a user message carries no author label').not.toContain('我');
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
