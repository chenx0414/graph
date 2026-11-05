import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

// A retry must never repeat work that already happened. The turn below runs one
// real file edit that appends a line to a sentinel file, and only then does the
// provider start dying: two cuts, then the answer. If any retry re-ran the turn
// - the transport one, or the node-level one that a failed generation used to
// trigger - the edit would apply twice and the sentinel would hold two lines.
//
// The sentinel is the proof: a file whose content is the side effect itself, not
// a counter the retry code could be written to satisfy.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

type Recorder = Record<string, unknown>;
function record(value: unknown): Recorder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
interface ChatMessage { role?: string; content?: unknown; tool_calls?: { id?: string }[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

function toolCall(response: import('node:http').ServerResponse, id: string, name: string, args: object) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
    { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
  response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  response.end('data: [DONE]\n\n');
}

function answer(response: import('node:http').ServerResponse, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  response.end('data: [DONE]\n\n');
}

function cut(response: import('node:http').ServerResponse, request: import('node:http').IncomingMessage) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.flushHeaders();
  request.socket.destroy();
  response.socket?.destroy();
}

async function launchSentinelTurn(root: string, cutAttempts: number) {
  let attempts = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    attempts += 1;
    const body = record(JSON.parse(Buffer.concat(chunks).toString())) as ChatBody;
    const messages = body.messages ?? [];
    const ranAlready = messages.some(message => message.role === 'tool');
    // The first generation asks for the side effect; every later generation is
    // about the answer that follows it.
    if (!ranAlready) {
      // The tool edits the file the turn was told to change: the replacement
      // keeps its own anchor, so running the tool twice leaves the line twice.
      toolCall(response, 'sentinel-1', 'edit', {
        path: 'sentinel.txt',
        edits: [{ oldText: 'start', newText: 'start\nrun' }],
      });
      return;
    }
    if (attempts <= cutAttempts) { cut(response, request); return; }
    answer(response, 'The sentinel turn completed.');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await writeFile(join(root, 'project/sentinel.txt'), 'start');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_SENTINEL_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const cli = await launchCli(root, { configPath, env: { GRAPH_SENTINEL_KEY: 'synthetic-only', NO_PROXY: '127.0.0.1,localhost' }, extraArgs: ['--execute'] });
  cleanup.push(() => cli.close());
  const created = await cli.request('/api/conversations', { method: 'POST', body: JSON.stringify({
    projectId: 'p', model: 'main', text: 'Run the sentinel edit once.', requestId: 'sentinel-turn',
  }) });
  const createdBody = await created.text();
  expect(created.status, createdBody).toBe(200);
  return { cli, attempts: () => attempts, conversationId: (JSON.parse(createdBody) as { conversationId: string }).conversationId };
}

async function errorMessages(cli: Awaited<ReturnType<typeof launchCli>>, conversationId: string) {
  const view = record(await (await cli.request(`/api/conversations/${conversationId}`)).json());
  const messages = Array.isArray(view.messages) ? view.messages.map(record) : [];
  return messages.filter(message => message.role === 'system' && message.kind === 'error').map(message => String(message.text ?? ''));
}

test('a retried send does not run the tool it already ran', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-sentinel-file-'));
  const sentinel = join(root, 'project', 'sentinel.txt');
  const turn = await launchSentinelTurn(root, 3);

  await expect.poll(async () => {
    const view = record(await (await turn.cli.request(`/api/conversations/${turn.conversationId}`)).json());
    const messages = Array.isArray(view.messages) ? view.messages.map(record) : [];
    return messages.filter(message => message.role === 'assistant').map(message => String(message.text ?? ''));
  }, { timeout: 40_000, interval: 100 }).toContain('The sentinel turn completed.');

  // One edit, one line, one side effect - although the connection was cut
  // twice after the edit had already been applied.
  expect(await readFile(sentinel, 'utf8')).toBe('start\nrun');
  expect(turn.attempts()).toBe(4);
}, 120_000);

test('a turn whose tools already ran is not sent again when the retries run out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-sentinel-exhausted-'));
  const sentinel = join(root, 'project', 'sentinel.txt');
  // Every attempt after the command ran is cut: the transport budget ends here.
  const turn = await launchSentinelTurn(root, 99);

  const text = await expect.poll(async () => (await errorMessages(turn.cli, turn.conversationId)).join('\n'),
    { timeout: 60_000, interval: 200 }).toContain('已自动重试 2 次仍失败');
  void text;

  // The failed generation had already applied the edit. A node-level retry would
  // apply it again; the sentinel says it did not.
  expect(await readFile(sentinel, 'utf8')).toBe('start\nrun');
  // Nothing was sent a fourth time: the second generation spent its whole budget.
  await expect.poll(() => turn.attempts(), { timeout: 20_000, interval: 200 }).toBe(4);
  // A turn that already worked on the graph is never described as spurious.
  expect((await errorMessages(turn.cli, turn.conversationId)).join('\n')).not.toContain('再发一次');
}, 150_000);
