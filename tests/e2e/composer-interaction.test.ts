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
  await expect.poll(() => send.isDisabled()).toBe(true);
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
