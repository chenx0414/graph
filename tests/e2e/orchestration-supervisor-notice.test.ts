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

// A project supervisor reports a milestone with ask_supervisor kind=notice. The
// notice must reach the global conversation and wake its master, while the
// project's own turn keeps running: no question opens, nothing waits.
test('a project supervisor notice reaches the global supervisor without blocking the sender', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-supervisor-notice-'));
  const results = new Map<string, unknown>();
  let globalSawNotice = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = record(JSON.parse(Buffer.concat(chunks).toString()));
      const messages = Array.isArray(body.messages) ? body.messages.map(record) : [];
      const tools = Array.isArray(body.tools) ? body.tools.map(record) : [];
      const names = tools.map(item => record(item.function).name);
      for (const message of messages) {
        if (message.role === 'tool' && typeof message.tool_call_id === 'string') results.set(message.tool_call_id, message.content);
      }
      const transcript = JSON.stringify(messages);
      const isProjectTurn = names.includes('ask_supervisor');
      if (names.includes('ask_user') && transcript.includes('来自项目主管的通知')) globalSawNotice += 1;
      const spoken = new Set(messages.flatMap(message => Array.isArray(message.tool_calls) ? message.tool_calls.map(call => record(call).id) : []));
      let call: { id: string; name: string; args: object } | undefined;
      if (isProjectTurn && !spoken.has('notice-1')) {
        call = { id: 'notice-1', name: 'ask_supervisor', args: {
          kind: 'notice', prompt: '归档界面草稿已就绪，请审阅。', milestone: 'draft_ready', evidence: 'plans/project-archive-ui.md', requestId: 'notice-1',
        } };
      }
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (call) {
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] }));
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      } else {
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'Understood.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
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
      credentials: { local: { secretRef: 'GRAPH_NOTICE_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, contextWindow: 32000, maxTokens: 2048, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_NOTICE_KEY: 'synthetic-key' } });
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return record(value);
    }
    const project = field(await request('/api/projects/p/thread', { requestId: 'project' }), 'conversationId');
    const global = field(await request('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
    await request(`/api/conversations/${project}/messages`, { requestId: 'message', text: 'Plan the archive UI.' });

    await expect.poll(() => results.has('notice-1'), { timeout: 20_000 }).toBe(true);
    expect(String(results.get('notice-1'))).toContain('delivered');
    // The sender's turn continued past the notice: it is not waiting for an answer.
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${project}`);
      const messages = Array.isArray(view.messages) ? view.messages : [];
      return messages.some(message => record(message).role === 'assistant' && record(message).text === 'Understood.');
    }, { timeout: 20_000 }).toBe(true);
    expect((await request(`/api/conversations/${project}`)).questions).toEqual([]);

    // The notice reached the global thread and woke its master.
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${global}`);
      const messages = Array.isArray(view.messages) ? view.messages : [];
      return messages.some(message => String(record(message).text ?? '').includes('来自项目主管的通知'));
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => globalSawNotice, { timeout: 20_000 }).toBeGreaterThan(0);
  } finally {
    await daemon?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
