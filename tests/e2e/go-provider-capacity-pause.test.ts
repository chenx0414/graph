import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

// A provider that is at capacity says how long to wait.
//
// A rate limit is a pause, not a failed send: the next attempt must start
// after the pause the provider asked for. Retrying in half a second turns one
// capacity answer into a burst of full-size requests, so every attempt lands
// inside the same window and the turn fails although waiting would have
// succeeded. The proof is the real daemon and a real endpoint that timestamps
// the requests it receives.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ConversationView { messages: { role: string; text?: string }[] }

test('a capacity answer that asks for a pause is honored before the retry', async () => {
  const received: number[] = [];
  const server: Server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* the body is not the proof; the timing is */ }
    received.push(Date.now());
    if (received.length === 1) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      response.end('{"error":{"message":"rate limit reached"}}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'capacity', object: 'chat.completion.chunk', model: 'local',
      choices: [{ index: 0, delta: { content: 'Answer after the pause.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-capacity-pause-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_CAPACITY_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_CAPACITY_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Answer after the pause.', requestId: 'capacity-pause' }),
  });
  const body = await created.text();
  expect(created.status, body).toBe(200);
  const { conversationId } = JSON.parse(body) as { conversationId: string };

  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    return view.messages.filter(message => message.role === 'assistant').map(message => message.text);
  }, { timeout: 30_000, interval: 100 }).toContain('Answer after the pause.');

  // One pause, one retry: the provider was asked twice and the second attempt
  // respected the two seconds it asked for.
  expect(received).toHaveLength(2);
  expect(received[1]! - received[0]!).toBeGreaterThanOrEqual(1_800);
}, 60_000);
