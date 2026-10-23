import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cleanup, fixture, usage } from '../fixtures/composer-lifecycle.ts';

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
