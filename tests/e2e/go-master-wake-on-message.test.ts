import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

// A message written into a conversation belongs to the Agent that has to answer
// it, whichever door it came through. On 2026-11-05 08:50 a delegation was
// written into a project thread, the thread stayed `pending`, and nothing was
// dispatched until a person typed an ordinary chat four minutes later: the
// delegation never woke the master, because only the chat door released the
// problem that was parking it.
//
// The proof drives both doors of the real daemon. The project master is first
// parked by a turn whose provider connection is cut, and then the delegation
// has to produce a new operation on its own - with no chat behind it.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

type Recorder = Record<string, unknown>;
function record(value: unknown): Recorder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function field(value: unknown, key: string): string {
  const found = record(value)[key];
  if (typeof found !== 'string' || !found) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return found;
}
interface ChatMessage { role?: string; content?: unknown; tool_calls?: { id?: string }[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

test('a delegation wakes a master that a failed turn left parked', async () => {
  let projectAttempts = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = record(JSON.parse(Buffer.concat(chunks).toString())) as ChatBody;
    const messages = body.messages ?? [];
    const names = (body.tools ?? []).map(tool => String(record(tool.function ?? {}).name ?? ''));
    const transcript = JSON.stringify(messages);
    if (names.includes('ask_supervisor')) {
      projectAttempts += 1;
      // The first turn is cut on every attempt it may make: it ends failed, and
      // its master is parked with a problem nobody has answered.
      if (!transcript.includes('来自全局主管的委派') && projectAttempts <= 3) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        request.socket.destroy();
        response.socket?.destroy();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'Delegation received.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    // The global supervisor delegates the work into the project thread.
    const spoken = new Set(messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!spoken.has('delegate-1')) {
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0, id: 'delegate-1', type: 'function',
        function: { name: 'delegate_work', arguments: JSON.stringify({
          projectId: 'p', brief: 'Archive the settings page.', acceptance: ['The page still renders.'],
          requestId: 'delegate-1',
        }) },
      }] }, finish_reason: null }] }));
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } else {
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'Delegated.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));

  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-message-wake-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  try {
    await mkdir(join(root, 'project'), { recursive: true });
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: join(root, 'project') }],
      credentials: { local: { secretRef: 'GRAPH_WAKE_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        contextWindow: 32000, maxTokens: 1024, credentialId: 'local' }] },
    }));
    const daemon = await launchCli(root, { configPath, env: { GRAPH_WAKE_KEY: 'synthetic-only', NO_PROXY: '127.0.0.1,localhost' }, extraArgs: ['--execute'] });
    cleanup.push(() => daemon.close());
    const post = async (path: string, body: object) => {
      const response = await daemon.request(path, { method: 'POST', body: JSON.stringify(body) });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return record(JSON.parse(text));
    };
    const view = async (conversationId: string) => record(await (await daemon.request(`/api/conversations/${conversationId}`)).json());
    const messagesOf = async (conversationId: string) => {
      const found = (await view(conversationId)).messages;
      return (Array.isArray(found) ? found : []).map(record);
    };

    const project = field(await post('/api/projects/p/thread', { requestId: 'project-thread' }), 'conversationId');
    const global = field(await post('/api/orchestration/global', { requestId: 'global-thread' }), 'conversationId');
    const projectTask = field(await view(project), 'anchorTaskId');

    // 1. A turn the provider breaks parks the project master.
    await post(`/api/conversations/${project}/messages`, { requestId: 'project-first', text: 'Start the archive work.' });
    await expect.poll(async () => (await messagesOf(project))
      .filter(message => message.role === 'system' && message.kind === 'error')
      .map(message => String(message.text ?? '')).join('\n'),
    { timeout: 60_000, interval: 200 }).toContain('已自动重试 2 次仍失败');

    const failedOperations = await (await daemon.request(`/api/tasks/${projectTask}/operations`)).json() as Recorder[];
    expect(failedOperations.length).toBe(1);

    // 2. The global supervisor delegates into that parked thread. Nothing else
    //    happens: no chat, no manual retry.
    await post(`/api/conversations/${global}/messages`, { requestId: 'global-delegate', text: 'Delegate the archive work to project p.' });

    // 3. The delegation alone has to produce a new operation for the thread.
    await expect.poll(async () => {
      const operations = await (await daemon.request(`/api/tasks/${projectTask}/operations`)).json() as Recorder[];
      return operations.length;
    }, { timeout: 30_000, interval: 200 }).toBe(2);

    // The dispatch is the parked master answering the delegation, not a message
    // that sat there: the thread holds the answer.
    await expect.poll(async () => (await messagesOf(project))
      .filter(message => message.role === 'assistant')
      .map(message => String(message.text ?? '')), { timeout: 30_000, interval: 200 }).toContain('Delegation received.');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 180_000);
