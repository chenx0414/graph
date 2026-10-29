import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

// A connection that dies before the provider says anything is not a turn that
// ran: no reply byte arrived, so no tool could have run. The same turn may be
// sent again on a fresh connection instead of failing the user's message. The
// attempt that died still leaves its usage unknown - the provider may bill it -
// and the ledger must not turn that into zero.
//
// The proof is the real daemon: the first request has its socket destroyed
// before any header, the second is answered, and the transcript shows the
// answer the user asked for.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface NodeRunView {
  invocations?: { id: string; usage: unknown; usageSource: string }[];
}

test('a connection that dies before any reply is retried on a fresh connection', async () => {
  const received: string[] = [];
  const server: Server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(body);
    if (received.length === 1) { request.socket.destroy(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'reconnected', object: 'chat.completion.chunk', model: 'local',
      choices: [{ index: 0, delta: { content: 'Answer after the reconnect.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-disconnect-retry-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_DISCONNECT_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_DISCONNECT_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Reply after the reconnect.', requestId: 'disconnect-retry' }),
  });
  const body = await created.text();
  expect(created.status, body).toBe(200);
  const { taskId, conversationId } = JSON.parse(body) as { taskId: string; conversationId: string };

  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { messages: { role: string; text?: string }[] };
    return view.messages.filter(message => message.role === 'assistant').map(message => message.text);
  }, { timeout: 30_000, interval: 100 }).toContain('Answer after the reconnect.');

  // Two attempts, the first with no usage evidence at all, the second priced.
  expect(received).toHaveLength(2);
  await expect.poll(async () => {
    const run = await (await daemon.request(`/api/tasks/${taskId}/nodes/master/run`)).json() as NodeRunView;
    return (run.invocations ?? []).map(call => call.usageSource);
  }, { timeout: 10_000, interval: 100 }).toEqual(['unknown', 'authoritative']);
  const run = await (await daemon.request(`/api/tasks/${taskId}/nodes/master/run`)).json() as NodeRunView;
  expect(run.invocations?.[0]?.usage).toBeNull();
}, 60_000);
