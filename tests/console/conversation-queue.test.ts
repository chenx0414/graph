import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { createApp } from '../../src/server/app.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-conversation-queue-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function gated(): { adapter: ActionAdapter; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter: ActionAdapter = {
    kind: 'agent',
    reserveTokens: 100,
    prepare: async () => async () => {
      await gate;
      return { outcome: 'completed' as const, output: { text: '收到。' }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  return { adapter, release };
}

test('queued messages can be cancelled one by one without disturbing the running turn', async () => {
  const root = await temp('cancel');
  const { adapter, release } = gated();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: adapter },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());

  const created = await runtime.conversations.create({ text: '第一问', requestId: 'queue-create' });
  const running = runtime.host.runReady();
  await expect.poll(async () => (await runtime.conversations.view(created.conversationId)).master?.status, { timeout: 10_000 }).toBe('running');

  const first = await runtime.conversations.chat(created.conversationId, { text: '排队一', requestId: 'queue-1' });
  const second = await runtime.conversations.chat(created.conversationId, { text: '排队二', requestId: 'queue-2' });
  expect(first).toMatchObject({ state: 'queued', pending: true });
  expect(second).toMatchObject({ state: 'queued', pending: true });

  // Cancel only the first queued message; the running turn and the second
  // queued message are untouched.
  const cancelled = await runtime.conversations.cancelMessage(created.conversationId, { messageId: first.messageId, requestId: 'cancel-1' });
  expect(cancelled).toMatchObject({ cancelled: true, state: 'cancelled' });
  expect(cancelled.cursor).toEqual(expect.any(Number));

  // The same requestId replays the recorded receipt instead of writing again.
  const replayed = await runtime.conversations.cancelMessage(created.conversationId, { messageId: first.messageId, requestId: 'cancel-1' });
  expect(replayed).toEqual(cancelled);

  const midFlight = await runtime.conversations.view(created.conversationId);
  expect(midFlight.master?.status).toBe('running');
  expect(midFlight.messages.map(message => [message.text, message.state])).toEqual([
    ['第一问', 'delivered'],
    ['排队一', 'cancelled'],
    ['排队二', 'queued'],
  ]);

  release();
  await running;
  await runtime.host.runReady();

  const final = await runtime.conversations.view(created.conversationId);
  expect(final.master?.status).toBe('succeeded');
  expect(final.messages.filter(message => message.role === 'assistant')).toHaveLength(2);
  expect(final.messages.map(message => [message.text, message.state])).toEqual([
    ['第一问', 'delivered'],
    ['排队一', 'cancelled'],
    ['收到。', 'done'],
    ['排队二', 'delivered'],
    ['收到。', 'done'],
  ]);

  // A cancelled or delivered message is never rewritten by a later cancel.
  const noop = await runtime.conversations.cancelMessage(created.conversationId, { messageId: final.messages[1]!.id, requestId: 'cancel-2' });
  expect(noop).toMatchObject({ cancelled: true, state: 'cancelled', cursor: null });
  const deliveredNoop = await runtime.conversations.cancelMessage(created.conversationId, { messageId: final.messages[0]!.id, requestId: 'cancel-3' });
  expect(deliveredNoop).toMatchObject({ cancelled: false, state: 'delivered', cursor: null });
}, 30_000);

test('cancelling an unknown or foreign message is a no-op', async () => {
  const root = await temp('foreign');
  const { adapter } = gated();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: adapter },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '第一问', requestId: 'foreign-create' });
  await runtime.conversations.pause(created.conversationId, 'foreign-pause');
  const queued = await runtime.conversations.chat(created.conversationId, { text: '排队', requestId: 'foreign-queue' });
  expect(queued).toMatchObject({ state: 'queued', pending: true });
  const other = await runtime.conversations.create({ text: '另一个会话', requestId: 'foreign-other' });

  const foreign = await runtime.conversations.cancelMessage(other.conversationId, { messageId: queued.messageId, requestId: 'foreign-cancel' });
  expect(foreign).toMatchObject({ cancelled: false, state: 'missing', cursor: null });
  expect((await runtime.conversations.view(created.conversationId)).messages.find(message => message.id === queued.messageId)?.state).toBe('queued');

  const unknown = await runtime.conversations.cancelMessage(created.conversationId, { messageId: 'does-not-exist', requestId: 'unknown-cancel' });
  expect(unknown).toMatchObject({ cancelled: false, state: 'missing' });
  expect(() => runtime.conversations.cancelMessage(created.conversationId, { messageId: '', requestId: 'empty-cancel' })).toThrow(/messageId/);
}, 30_000);

test('the cancel endpoint keeps the POST + requestId contract over HTTP', async () => {
  const root = await temp('http');
  const { adapter } = gated();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: adapter },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const origin = 'http://127.0.0.1:1';
  const app = await createApp(runtime, { origin });
  cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } });
  const headers = { origin, cookie: String(home.headers['set-cookie'] ?? ''), 'content-type': 'application/json' };

  const created = await runtime.conversations.create({ text: '第一问', requestId: 'http-create' });
  await runtime.conversations.pause(created.conversationId, 'http-pause');
  const queued = await runtime.conversations.chat(created.conversationId, { text: '排队', requestId: 'http-queue' });
  const url = `/api/conversations/${created.conversationId}/messages/${encodeURIComponent(queued.messageId)}/cancel`;
  const response = await app.inject({ method: 'POST', url, headers, payload: JSON.stringify({ requestId: 'http-cancel' }) });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({ cancelled: true, state: 'cancelled' });
  const replay = await app.inject({ method: 'POST', url, headers, payload: JSON.stringify({ requestId: 'http-cancel' }) });
  expect(JSON.parse(replay.body)).toEqual(JSON.parse(response.body));
}, 30_000);
