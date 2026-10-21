import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * Native node quotas hold and release reservations, charge each accepted turn
 * once and refuse only the exhausted node.
 *
 * The quota lives in the Go daemon: it reserves one turn's worth of tokens
 * before the turn starts, holds that reservation while the turn is in flight,
 * releases it when the turn settles and charges what the provider actually
 * reported. A node that declared no quota is never refused, and a node whose
 * quota is exhausted is refused with a budget question parked for the user -
 * the other node of the same graph keeps running on its own ledger.
 *
 * The proof is a real daemon, a real graph and two real node models: the
 * master Agent creates the graph and hands the work to the nodes with its own
 * graph tools, exactly as the console drives it.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

const DEFINITION = {
  schemaVersion: 2,
  name: 'Independent quotas',
  protocols: { data: { type: 'object' } },
  nodes: {
    finite: {
      recipe: 'coder@1', model: 'finite', task: 'Answer this job once.',
      budget: { tokens: 200_100 },
      inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {},
    },
    unlimited: {
      recipe: 'coder@1', model: 'unlimited', task: 'Answer this job once.',
      budget: { tokens: null },
      inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {},
    },
  },
  modules: {}, edges: {}, inputs: {}, outputs: {},
};

/** The master Agent: it creates the graph, then hands the work to the nodes. */
async function masterProvider() {
  const requests: ChatBody[] = [];
  let graphId = '';
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    const spoken = (body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.function?.name ?? ''));
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      const found = /"graphId"\s*:\s*"([^"]+)"/.exec(message.content);
      if (found) graphId = found[1]!;
    }
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const calls = (entries: { id: string; name: string; args: unknown }[]) => frame({
      id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: entries.map((entry, index) => ({
        index, id: entry.id, type: 'function', function: { name: entry.name, arguments: JSON.stringify(entry.args) } })) }, finish_reason: null }],
    });
    const stop = frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!spoken.includes('graph_create')) {
      response.write(calls([{ id: 'call-create', name: 'graph_create', args: { requestId: 'create-graph', definition: DEFINITION } }]));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (!spoken.includes('graph_send')) {
      response.write(calls([
        { id: 'send-finite-1', name: 'graph_send', args: { graphId, nodeId: 'finite', input: 'job', value: { label: 'first' } } },
        { id: 'send-finite-2', name: 'graph_send', args: { graphId, nodeId: 'finite', input: 'job', value: { label: 'second' } } },
        { id: 'send-finite-3', name: 'graph_send', args: { graphId, nodeId: 'finite', input: 'job', value: { label: 'third' } } },
        { id: 'send-finite-4', name: 'graph_send', args: { graphId, nodeId: 'finite', input: 'job', value: { label: 'refused' } } },
        { id: 'send-unlimited', name: 'graph_send', args: { graphId, nodeId: 'unlimited', input: 'job', value: { label: 'independent' } } },
      ]));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The work is dispatched.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    graphId: () => graphId,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/**
 * A node model. The node session opens with one call that carries no tools;
 * every call that carries tools is a real turn of the node.
 */
async function nodeProvider(usage: { prompt_tokens: number; completion_tokens: number }, options: { hold?: boolean } = {}) {
  const requests: ChatBody[] = [];
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  let heldOnce = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    if (options.hold && !heldOnce && (body.tools ?? []).length > 0) {
      heldOnce = true;
      entered();
      await held;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The answer.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    turns: () => requests.filter(request => (request.tools ?? []).length > 0),
    arrived,
    release: () => release(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('native node quotas hold and release reservations, charge each accepted turn once and refuse only the exhausted node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-budget-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const master = await masterProvider();
  const finite = await nodeProvider({ prompt_tokens: 40, completion_tokens: 10 }, { hold: true });
  const unlimited = await nodeProvider({ prompt_tokens: 20_000_000, completion_tokens: 1 }, { hold: true });

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'budget' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { budget: { secretRef: 'GRAPH_BUDGET_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'finite', provider: 'graph-finite', modelId: 'finite-model', baseUrl: finite.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'unlimited', provider: 'graph-unlimited', modelId: 'unlimited-model', baseUrl: unlimited.baseUrl, contextWindow: 100000000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_BUDGET_KEY: 'budget-synthetic' }, extraArgs: ['--execute'] });
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    };

    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Give two nodes their own quota.', requestId: 'node-budget' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // The master creates the graph and hands the work to the nodes.
    await expect.poll(() => master.graphId(), { timeout: 60_000, interval: 250 }).toMatch(/^[0-9a-f-]{36}$/);
    const graphId = master.graphId();

    // The first accepted turn holds its reservation while the provider is busy.
    await Promise.race([
      Promise.all([finite.arrived, unlimited.arrived]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the first node turn never reached the provider')), 60_000)),
    ]);
    const inflight = await request(`/api/tasks/${graphId}/nodes/finite/run`);
    expect(inflight.status, JSON.stringify(inflight.body)).toBe(200);
    const instance = (inflight.body as { instance: { budget: number | null; unlimited: boolean; used: number; reserved: number } }).instance;
    expect(instance).toMatchObject({ budget: 200_100, unlimited: false, used: 0, reserved: 200_000 });
    const invocations = (inflight.body as { invocations: { state: string; reserved: number }[] }).invocations;
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations[0]).toMatchObject({ state: 'inflight' });
    expect(invocations[0]!.reserved).toBeGreaterThan(0);
    // The other node keeps its own ledger while this one is in flight.
    const other = await request(`/api/tasks/${graphId}/nodes/unlimited/run`);
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect((other.body as { instance: { budget: number | null; unlimited: boolean; used: number; reserved: number } }).instance)
      .toMatchObject({ budget: null, unlimited: true, used: 0, reserved: 0 });

    finite.release();
    unlimited.release();

    // The exhausted node is refused, the other one finishes on its own quota.
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${graphId}`);
      const nodes = (view.body as { nodes: { id: string; status: string }[] }).nodes ?? [];
      return nodes.map(node => `${node.id}:${node.status}`).sort().join(',');
    }, { timeout: 120_000, interval: 500 }).toBe('finite:blocked,unlimited:succeeded');

    const finiteRun = await request(`/api/tasks/${graphId}/nodes/finite/run`);
    expect(finiteRun.status, JSON.stringify(finiteRun.body)).toBe(200);
    expect((finiteRun.body as { instance: { budget: number | null; unlimited: boolean; used: number; reserved: number } }).instance)
      .toMatchObject({ budget: 200_100, unlimited: false, used: 150, reserved: 0 });
    const unlimitedRun = await request(`/api/tasks/${graphId}/nodes/unlimited/run`);
    expect(unlimitedRun.status, JSON.stringify(unlimitedRun.body)).toBe(200);
    expect((unlimitedRun.body as { instance: { budget: number | null; unlimited: boolean; used: number; reserved: number } }).instance)
      .toMatchObject({ budget: null, unlimited: true, used: 20_000_001, reserved: 0 });

    // Three turns were accepted and charged; the fourth was never dispatched.
    expect(finite.turns()).toHaveLength(3);
    expect(unlimited.turns()).toHaveLength(1);

    // The refusal parks a budget question for the user on the graph itself.
    const task = await request(`/api/tasks/${graphId}`);
    const questions = (task.body as { questions: { kind: string; nodeId: string; status: string }[] }).questions ?? [];
    expect(questions).toMatchObject([{ kind: 'budget', nodeId: 'finite', status: 'open' }]);
  } finally {
    finite.release(); unlimited.release();
    await daemon?.close(); await master.close(); await finite.close(); await unlimited.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
