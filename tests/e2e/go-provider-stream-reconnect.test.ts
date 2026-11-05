import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

// A provider that answered with headers and then died on its body is the case
// the user reported: `local error: tls: bad record MAC` arrives after the
// response started, nothing of the answer was read, and the turn used to end
// with "消息已保留，可以再发一次重试" - the same message the user had already
// sent. Nothing was answered, so no tool can have run and the very same send
// may go again on a fresh connection, inside the same durable submission.
//
// The proof is the real daemon against a real provider socket: the first two
// requests are cut after their headers, the third answers, and the transcript
// holds exactly one user message and the answer.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}

interface ConversationView { messages?: Record<string, unknown>[] }
interface TaskEvent { type: string; data: Record<string, unknown> }

/** A provider stream that dies after its headers and before any answer byte. */
function cutStream(response: import('node:http').ServerResponse, request: import('node:http').IncomingMessage) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.flushHeaders();
  request.socket.destroy();
  response.socket?.destroy();
}

function answer(response: import('node:http').ServerResponse, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'answer', object: 'chat.completion.chunk', model: 'local',
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 } })}\n\ndata: [DONE]\n\n`);
}

async function serve(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, attempt: number) => void) {
  let attempts = 0;
  const server: Server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    attempts += 1;
    handler(request, response, attempts);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, attempts: () => attempts };
}

async function daemon(root: string, baseUrl: string, key: string) {
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: key } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const cli = await launchCli(root, { configPath, env: { [key]: 'synthetic-only', NO_PROXY: '127.0.0.1,localhost' }, extraArgs: ['--execute'] });
  cleanup.push(() => cli.close());
  return cli;
}

async function conversation(cli: Awaited<ReturnType<typeof launchCli>>, text: string, requestId: string) {
  const created = await cli.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text, requestId }) });
  const body = await created.text();
  expect(created.status, body).toBe(200);
  return JSON.parse(body) as { taskId: string; conversationId: string };
}

async function messages(cli: Awaited<ReturnType<typeof launchCli>>, conversationId: string) {
  const view = record(await (await cli.request(`/api/conversations/${conversationId}`)).json()) as ConversationView;
  return (view.messages ?? []).map(record);
}

test('a stream that dies after its headers is sent again on the same submission', async () => {
  const provider = await serve((request, response, attempt) => {
    if (attempt <= 2) { cutStream(response, request); return; }
    answer(response, 'Answer after two reconnects.');
  });
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-stream-reconnect-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cli = await daemon(root, provider.baseUrl, 'GRAPH_STREAM_RECONNECT_KEY');
  const { taskId, conversationId } = await conversation(cli, 'Reply after the stream was cut.', 'stream-reconnect');

  // The answer arrived: the two dead attempts did not cost the user the turn.
  await expect.poll(async () => (await messages(cli, conversationId))
    .filter(message => message.role === 'assistant')
    .map(message => message.text), { timeout: 30_000, interval: 100 }).toContain('Answer after two reconnects.');

  // Two automatic retries, then the answer: three attempts of the same send.
  expect(provider.attempts()).toBe(3);

  // The retry stayed inside one durable submission: one user message, one turn.
  const user = (await messages(cli, conversationId)).filter(message => message.role === 'user');
  expect(user).toHaveLength(1);
  const operations = await (await cli.request(`/api/tasks/${taskId}/operations`)).json();
  expect(Array.isArray(operations) ? operations.length : 0).toBe(1);

  // Each retry waits before it dials again: an immediate replay would turn one
  // corrupted connection into a burst against the same endpoint.
  await expect.poll(async () => {
    const events = await (await cli.request(`/api/tasks/${taskId}/events?after=0&limit=1000`)).json() as TaskEvent[];
    return events
      .filter(event => event.type === 'provider.transport' && record(event.data).phase === 'reconnect')
      .map(event => record(event.data).delayMs);
  }, { timeout: 10_000, interval: 100 }).toEqual([500, 1000]);
}, 90_000);

test('retries that all fail report the real reason and how many retries ran', async () => {
  const provider = await serve((request, response) => { cutStream(response, request); });
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-stream-exhausted-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cli = await daemon(root, provider.baseUrl, 'GRAPH_STREAM_EXHAUSTED_KEY');
  const { conversationId } = await conversation(cli, 'This endpoint never answers.', 'stream-exhausted');

  const errors = await expect.poll(async () => (await messages(cli, conversationId))
    .filter(message => message.role === 'system' && message.kind === 'error')
    .map(message => String(message.text ?? '')), { timeout: 40_000, interval: 200 }).not.toEqual([]);
  void errors;
  const [text] = (await messages(cli, conversationId))
    .filter(message => message.role === 'system' && message.kind === 'error')
    .map(message => String(message.text ?? ''));

  // What happened, in the numbers the daemon actually spent.
  expect(text).toContain('已自动重试 2 次仍失败');
  // The original failure, so the user can tell a broken connection from a bad model.
  expect(text).toMatch(/原因：.*(EOF|closed the stream|connection)/i);
  // The turn was already retried for the user: asking them to send it again is a lie.
  expect(text).not.toContain('再发一次');

  // Every attempt was spent before the failure was reported.
  expect(provider.attempts()).toBe(3);
}, 90_000);
