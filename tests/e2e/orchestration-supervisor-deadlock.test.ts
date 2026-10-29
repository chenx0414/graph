import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function field(value: unknown, key: string): string {
  const result = record(value)[key];
  if (typeof result !== 'string' || !result) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return result;
}

// A failed turn opens a question its own supervisor has to answer. If that
// question also blocked the supervisor, nobody could ever answer it: dispatch
// only lists a pending master. This drives a real truncated tool call into a
// real daemon and then checks the session is still alive afterwards.
test('a supervisor that owns an execution failure stays dispatchable and answers its next message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-supervisor-deadlock-'));
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { /* drain */ }
    calls += 1;
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (calls === 1) {
      // The provider cut the arguments: the tool call never becomes a call.
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'cut-1', type: 'function', function: { name: 'ask_supervisor', arguments: '{"prompt":"进度",' } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } else {
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: '明白了。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider did not bind');
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    await mkdir(join(root, 'project'));
    await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(root, 'project') }],
      credentials: { local: { secretRef: 'GRAPH_DEADLOCK_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, contextWindow: 32000, maxTokens: 2048, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_DEADLOCK_KEY: 'synthetic-key' } });
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return record(value);
    }
    const project = field(await request('/api/projects/p/thread', { requestId: 'project' }), 'conversationId');
    const view = async () => await request(`/api/conversations/${project}`);

    await request(`/api/conversations/${project}/messages`, { requestId: 'm1', text: '开始。' });
    // The failed turn leaves an open question its own supervisor must answer.
    await expect.poll(async () => {
      const questions = (await view()).questions;
      return Array.isArray(questions) && questions.some(question => record(question).status === 'open');
    }, { timeout: 30_000, interval: 250 }).toBe(true);

    // The supervisor is not wedged: it stays dispatchable, not blocked.
    expect(record(record(await view()).master).status).not.toBe('blocked');

    // The session keeps working, with nobody answering that question by hand.
    await request(`/api/conversations/${project}/messages`, { requestId: 'm2', text: '继续。' });
    await expect.poll(async () => {
      const messages = (await view()).messages;
      return Array.isArray(messages) && messages.some(message => record(message).role === 'assistant' && record(message).text === '明白了。');
    }, { timeout: 30_000, interval: 250 }).toBe(true);
  } finally {
    await daemon?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
