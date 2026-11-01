import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * Reloading the extension host is an action, not a restart.
 *
 * Measured 2026-11-01: an extension reads its own configuration when the
 * extension host starts, and the host is a daemon-wide singleton, so an MCP
 * server installed while the app was running stayed invisible in every
 * conversation until the app restarted. The product answer is this endpoint:
 * close the host, let the next session start a new one.
 *
 * Two things a person can observe are asserted here, on the real daemon:
 *   - a reload with no host running answers honestly ("nothing was running")
 *     instead of starting one just to close it;
 *   - a reload while a turn is in flight is refused, because closing the host
 *     would kill the extension processes that turn is calling.
 */

/** A provider that answers when told to, so a turn can be held open. */
const gatedProvider = () => {
  let release: (() => void) | undefined;
  const requests: number[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(Date.now());
    await new Promise<void>(resolve => { release = resolve; });
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: '收到。' }, finish_reason: null }] }));
    response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    response.end('data: [DONE]\n\n');
  });
  return {
    requests,
    opened: () => requests.length,
    release: () => { release?.(); release = undefined; },
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
};

test('reloading the extension host reports what it did and refuses mid-turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-extensions-reload-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = gatedProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_EXT_RELOAD_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-ext-reload', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_EXT_RELOAD_KEY: 'synthetic-ext-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };

    // Nothing has started an extension host in this daemon yet.
    const idle = await request('/api/extensions/reload', 'POST', { requestId: 'reload-idle' });
    expect(idle.status, JSON.stringify(idle.body)).toBe(200);
    expect(idle.body).toMatchObject({ reloaded: false, deferred: false });
    const beforeDeferred = ((await request('/api/extensions/status')).body as { applied: number }).applied;

    // Hold a turn open, then try to reload the host underneath it.
    const created = await request('/api/conversations', 'POST', { model: 'local', text: '第一轮：HOLD_ONE', requestId: 'ext-conversation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    await expect.poll(provider.opened, { timeout: 60_000, interval: 100 }).toBe(1);

    const refused = await request('/api/extensions/reload', 'POST', { requestId: 'reload-mid-turn' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect((refused.body as { code?: string }).code).toBe('invalid_state');

    // A deferred request is accepted mid-turn and applied once the daemon is
    // idle: refusing would make the action unusable in the moment it matters.
    const queued = await request('/api/extensions/reload', 'POST', { requestId: 'reload-deferred', deferred: true });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect(queued.body).toMatchObject({ reloaded: false, deferred: true });
    await expect.poll(async () => (await request('/api/extensions/status')).body, { timeout: 10_000, interval: 100 })
      .toMatchObject({ pending: true });

    // The same call is accepted once the turn settles.
    provider.release();
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const messages = ((view.body as { messages?: { role?: string }[] }).messages) ?? [];
      return messages.filter(message => message.role === 'assistant').length;
    }, { timeout: 60_000, interval: 250 }).toBe(1);
    // The queued reload ran on its own once the turn settled, and was counted.
    await expect.poll(async () => (await request('/api/extensions/status')).body, { timeout: 30_000, interval: 200 })
      .toMatchObject({ pending: false, applied: beforeDeferred + 1 });
    const accepted = await request('/api/extensions/reload', 'POST', { requestId: 'reload-settled' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ reloaded: false, deferred: false });
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
