import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A message that waits behind a running turn can be taken back.
 *
 * The user sends a second message while the master is still working on the
 * first one. That message waits in the queue, and the user may withdraw it.
 * Withdrawing it is a fact: the message ends up cancelled, the same request
 * does not withdraw it twice, and a message that is not there is reported as
 * missing instead of being invented.
 *
 * The proof is the real Go process; the queue state is read back from the
 * conversation the backend keeps.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-conversation-queue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // The first turn is held open, so the second message really has to wait.
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const provider = await openaiServer([
    { beforeReply: () => held, text: 'The first answer.' },
    { text: 'The second answer.' },
    { text: 'Another answer.' },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_QUEUE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'synthetic-queue-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, daemon, request, provider, release };
}

interface Message { id: string; role: string; text: string; state: string }

test('a message queued behind a running turn can be withdrawn, and only once', async () => {
  const f = await fixture();

  const created = await f.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'The first request', requestId: 'conversation-1' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  // The master is busy with the first turn when the second message arrives.
  await expect.poll(() => f.provider.requests.length, { timeout: 30_000, interval: 100 }).toBe(1);
  const queued = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'The queued request', requestId: 'message-1' }),
  });
  expect(queued.status, JSON.stringify(queued.body)).toBe(200);

  // The message waits in the queue instead of reaching the provider.
  let messageId = '';
  await expect.poll(async () => {
    const history = await f.request(`/api/conversations/${conversationId}/history`);
    const messages = (history.body as { messages?: Message[] }).messages ?? [];
    const entry = messages.find(message => message.text === 'The queued request');
    messageId = entry?.id ?? '';
    return entry?.state;
  }, { timeout: 30_000, interval: 100 }).toBe('queued');

  const cancelled = await f.request(`/api/conversations/${conversationId}/messages/${messageId}/cancel`, {
    method: 'POST', body: JSON.stringify({ requestId: 'cancel-1' }),
  });
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  expect(cancelled.body as { cancelled?: boolean; state?: string }).toMatchObject({ cancelled: true, state: 'cancelled' });

  // The same request does not withdraw it a second time.
  const again = await f.request(`/api/conversations/${conversationId}/messages/${messageId}/cancel`, {
    method: 'POST', body: JSON.stringify({ requestId: 'cancel-1' }),
  });
  expect(again.status).toBe(200);
  expect(again.body as { cancelled?: boolean; state?: string }).toMatchObject({ cancelled: true, state: 'cancelled' });

  // The message really left the queue.
  const history = await f.request(`/api/conversations/${conversationId}/history`);
  const messages = (history.body as { messages?: Message[] }).messages ?? [];
  expect(messages.find(message => message.id === messageId)?.state).toBe('cancelled');

  f.release();
}, 90_000);

test('withdrawing a message that is not in the conversation is reported as missing', async () => {
  const f = await fixture();

  const created = await f.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'The first request', requestId: 'conversation-2' }),
  });
  const conversationId = (created.body as { conversationId: string }).conversationId;

  const missing = await f.request(`/api/conversations/${conversationId}/messages/does-not-exist/cancel`, {
    method: 'POST', body: JSON.stringify({ requestId: 'cancel-missing' }),
  });
  expect(missing.status, JSON.stringify(missing.body)).toBe(200);
  expect(missing.body as { cancelled?: boolean; state?: string }).toMatchObject({ cancelled: false, state: 'missing' });

  f.release();
}, 90_000);
