import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

const rsiToolNames = ['read_rsi_status', 'apply_rsi_change'];

async function provider() {
  const requests: { tools?: { function?: { name?: string } }[] }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    try { requests.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { requests.push({}); }
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: '好的。' }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

function offeredTools(entry: { tools?: { function?: { name?: string } }[] } | undefined) {
  return (entry?.tools ?? []).map(tool => tool.function?.name ?? '').filter(Boolean);
}

test('the self-improvement tools are offered to the main thread and to nothing else', async () => {
  const model = await provider();
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-rsi-main-only-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(join(root, 'project'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: join(root, 'project') }],
      credentials: { local: { secretRef: 'GRAPH_RSI_ONLY_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-rsi', grade: 'high',
        api: 'openai-completions', baseUrl: model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_RSI_ONLY_KEY: 'synthetic-rsi-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
    };

    const global = await request('/api/orchestration/global', 'POST', { requestId: 'rsi-global' });
    expect(global.status, JSON.stringify(global.body)).toBe(200);
    const globalConversation = String(global.body.conversationId);
    const sentGlobal = await request(`/api/conversations/${globalConversation}/messages`, 'POST', { text: '你好。', requestId: 'rsi-global-turn' });
    expect(sentGlobal.status, JSON.stringify(sentGlobal.body)).toBe(200);
    await expect.poll(() => model.requests.length, { timeout: 30_000, interval: 200 }).toBeGreaterThan(0);

    const thread = await request('/api/projects/p/thread', 'POST', { requestId: 'rsi-thread' });
    expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    const projectConversation = String(thread.body.conversationId);
    const before = model.requests.length;
    const sentProject = await request(`/api/conversations/${projectConversation}/messages`, 'POST', { text: '你好。', requestId: 'rsi-thread-turn' });
    expect(sentProject.status, JSON.stringify(sentProject.body)).toBe(200);
    await expect.poll(() => model.requests.length, { timeout: 30_000, interval: 200 }).toBeGreaterThan(before);

    const main = offeredTools(model.requests[0]);
    const project = offeredTools(model.requests[before]);
    expect(main.filter(name => rsiToolNames.includes(name)).length, `main tools: ${main.join(',')}`).toBeGreaterThan(0);
    expect(project.filter(name => rsiToolNames.includes(name)), `project tools: ${project.join(',')}`).toEqual([]);
  } finally {
    await daemon?.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
