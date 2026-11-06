import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A turn that spends more than the configured ceiling still goes through.
 *
 * The daemon still counts what a turn costs, and still reports it, but the
 * number no longer decides whether the next send happens: a session that
 * crossed the old limit keeps running, parks no budget question, and its usage
 * keeps growing past the ceiling. The proof is a real daemon and a real model
 * service that reports usage larger than the configured default.
 */

const ceiling = 100;
const spent = { prompt_tokens: 4_000, completion_tokens: 1_000 };

interface Endpoint { baseUrl: string; requests: number; close: () => Promise<void> }

async function endpoint(): Promise<Endpoint> {
  const state = { requests: 0 };
  const server: Server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    state.requests += 1;
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Answered past the ceiling.' }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: spent }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    get requests() { return state.requests; },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface NodeRunView {
  instance?: { used: number; modelsUsed: string[] };
  operations?: { state: string }[];
  questions?: { kind: string; status: string }[];
}

test('a turn that spends past the configured ceiling still runs and parks no budget question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-no-budget-ceiling-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const model = await endpoint();
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      models: { entries: [{
        id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
      }] },
      credentials: { local: { secretRef: 'GRAPH_NO_CEILING_KEY' } },
      limits: { defaultBudgetTokens: ceiling },
    }, null, 2));
    daemon = await launchCli(root, { configPath, env: { GRAPH_NO_CEILING_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    };

    const created = await request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Spend as much as the job needs.', requestId: 'past-ceiling' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const taskId = (created.body as { taskId: string }).taskId;
    const run = async (): Promise<NodeRunView> => (await request(`/api/tasks/${taskId}/nodes/master/run`)).body as NodeRunView;

    // Two real turns, so the second one is sent after the ceiling is already
    // crossed: the limit no longer decides anything.
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const messages = (view.body as { messages?: { role: string }[] }).messages ?? [];
      return messages.filter(message => message.role === 'assistant').length;
    }, { timeout: 60_000, interval: 250 }).toBeGreaterThanOrEqual(1);

    const sent = await request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'And another turn after that.', requestId: 'past-ceiling-again' }),
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const messages = (view.body as { messages?: { role: string }[] }).messages ?? [];
      return messages.filter(message => message.role === 'assistant').length;
    }, { timeout: 60_000, interval: 250 }).toBeGreaterThanOrEqual(2);

    const settled = await run();
    // The usage is counted and reported, and it is far past the configured ceiling.
    expect(settled.instance?.used ?? 0).toBeGreaterThan(ceiling);
    expect(model.requests).toBeGreaterThanOrEqual(2);
    // Nothing was parked and nothing refused: the ceiling is not a gate.
    expect((settled.questions ?? []).filter(question => question.kind === 'budget')).toEqual([]);
    expect((settled.operations ?? []).every(operation => operation.state !== 'interrupted')).toBe(true);
  } finally {
    await daemon?.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
