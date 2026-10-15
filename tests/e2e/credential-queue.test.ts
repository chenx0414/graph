import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test.each([
  { api: 'openai-completions', header: 'authorization', prefix: 'Bearer ', explicit: false },
  { api: 'anthropic-messages', header: 'x-api-key', prefix: '', explicit: false },
  { api: 'openai-completions', header: 'authorization', prefix: 'Bearer ', explicit: true },
] as const)('$api queued sends honor live limits and key rotation while explicit auth=$explicit stays authoritative', async ({ api, header, prefix, explicit }) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-credential-queue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const seen = new Map<string, string>();
  const releases = new Map<string, () => void>();
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[]; messages: { role: string; content: unknown }[] };
    const user = [...body.messages].reverse().find(message => message.role === 'user');
    const text = JSON.stringify(user?.content);
    const label = ['first', 'second', 'third', 'fourth'].find(label => text?.includes(`Queue contract ${label}`));
    if (label && body.tools?.length) {
      seen.set(label, String(request.headers[header] ?? ''));
      if (label !== 'fourth') await new Promise<void>(resolve => { releases.set(label, resolve); });
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (api === 'anthropic-messages') {
      for (const event of [
        { type: 'message_start', message: { id: 'queue-response', type: 'message', role: 'assistant', model: 'local', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Queue contract completed' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Queue contract completed' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  cleanup.push(async () => { for (const release of releases.values()) release(); });
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  const document = { version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } }, limits: { credentials: { local: 2 } }, models: { entries: [{ id: 'local', provider: 'graph-local', grade: 'high', api, ...(explicit ? { headers: { authorization: 'Bearer original-synthetic-key' } } : {}), baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } };
  await writeFile(configPath, JSON.stringify(document));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true, env: { HOME: root, GRAPH_LOCAL_KEY: 'original-synthetic-key' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const post = (path: string, body: unknown, app = false) => fetch(`${daemon.url}${path}`, { method: 'POST', headers: app ? { ...headers, 'x-graph-app-token': daemon.appToken } : headers, body: JSON.stringify(body) });
  const create = async (label: string) => {
    const response = await post('/api/conversations', { model: 'local', text: `Queue contract ${label}`, requestId: label });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ taskId: string }>;
  };
  const run = async (taskId: string) => (await fetch(`${daemon.url}/api/tasks/${taskId}/nodes/master/run`, { headers })).json();
  const first = await create('first'); const second = await create('second');
  await expect.poll(() => seen.has('first') && seen.has('second'), { timeout: 20000 }).toBe(true);
  const third = await create('third');
  await expect.poll(async () => (await run(third.taskId)).operations.some((operation: { waitingSlot: boolean }) => operation.waitingSlot), { timeout: 20000 }).toBe(true);
  expect(seen.has('third')).toBe(false);
  expect(await (await post('/api/config', { expectedRevision: 0, document: { ...document, limits: { credentials: { local: 1 } } } })).json()).toMatchObject({ applied: true });
  releases.get('first')!();
  await expect.poll(async () => (await run(first.taskId)).invocations.some((invocation: { cost: unknown }) => invocation.cost !== null), { timeout: 20000 }).toBe(true);
  expect((await run(third.taskId)).operations.some((operation: { waitingSlot: boolean }) => operation.waitingSlot)).toBe(true);
  expect(seen.has('third')).toBe(false);
  releases.get('second')!();
  await expect.poll(() => seen.has('third'), { timeout: 20000 }).toBe(true);
  expect(seen.get('third')).toBe(`${prefix}original-synthetic-key`);
  const fourth = await create('fourth');
  await expect.poll(async () => (await run(fourth.taskId)).operations.some((operation: { waitingSlot: boolean }) => operation.waitingSlot), { timeout: 20000 }).toBe(true);
  expect(await (await post('/api/app/secret', { ref: 'GRAPH_LOCAL_KEY', value: 'rotated-synthetic-key' }, true)).json()).toMatchObject({ applied: true });
  releases.get('third')!();
  await expect.poll(() => seen.has('fourth'), { timeout: 20000 }).toBe(true);
  expect(seen.get('fourth')).toBe(`${prefix}${explicit ? 'original-synthetic-key' : 'rotated-synthetic-key'}`);
  await expect.poll(async () => (await run(fourth.taskId)).invocations.some((invocation: { cost: unknown }) => invocation.cost !== null), { timeout: 20000 }).toBe(true);
}, 120_000);
