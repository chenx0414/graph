import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * One node serializes a delivery, a queued chat and a later delivery, while
 * another node of the same graph completes on its own.
 *
 * The queue is the graph's own: a node takes one piece of work at a time, so
 * the chat that arrives while the first delivery is running waits behind it
 * instead of racing it, and the delivery that arrives after the chat waits
 * behind the chat. The other node is not part of that queue and finishes
 * while the first one is still busy.
 *
 * The proof is a real daemon and a real graph: the master Agent creates the
 * graph, hands the work to the nodes and reads the queue back with its own
 * graph tools.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

const DEFINITION = {
  schemaVersion: 2,
  name: 'Node queue',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: {
      recipe: 'coder@1', model: 'a', task: 'Submit the assigned output for deliveries; answer chats',
      inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
    },
    b: {
      recipe: 'coder@1', model: 'b', task: 'Submit the assigned output for deliveries; answer chats',
      inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
    },
  },
  modules: {}, edges: {}, inputs: {},
  outputs: { a: { from: 'a.out', protocol: 'ping' }, b: { from: 'b.out', protocol: 'ping' } },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

interface MasterCall { id: string; name: string; args: unknown; until?: (results: Map<string, string>) => boolean }

/**
 * The master Agent. It plays the plan in order and records what every tool
 * call answered, so the test can read the queue the way the model read it.
 * A call that asks for a state the graph has not reached yet is asked again.
 */
async function masterProvider(plan: (graphId: string) => MasterCall[], gates: Record<string, Promise<void>>) {
  const results = new Map<string, string>();
  const requests: ChatBody[] = [];
  const served = new Map<string, string>();
  const repeats = new Map<string, number>();
  let graphId = '';
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const base = served.get(message.tool_call_id ?? '') ?? message.tool_call_id ?? '';
      if (base) results.set(base, content);
      const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
      if (found) graphId = found[1]!;
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan(graphId).find(call => !spoken.has(call.id) || (call.until && !call.until(results)));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The queue is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const repeat = repeats.get(next.id) ?? 0;
    const id = repeat === 0 ? next.id : `${next.id}-${repeat}`;
    if (next.until && !next.until(results)) {
      repeats.set(next.id, repeat + 1);
      served.set(id, next.id);
    } else {
      served.set(id, next.id);
    }
    await gates[next.id]?.catch(() => undefined);
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    graphId: () => graphId,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/**
 * A node model. The node session opens with one call that carries no tools;
 * every call that carries tools is a real turn of the node.
 */
async function nodeProvider(actions: string[], options: { holdFirst?: boolean } = {}) {
  const requests: ChatBody[] = [];
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  let heldOnce = false;
  let index = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    const withTools = (body.tools ?? []).length > 0;
    if (options.holdFirst && withTools && !heldOnce) {
      heldOnce = true;
      entered();
      await held;
    }
    const action = withTools ? (actions[index++] ?? 'text') : 'text';
    if (action.startsWith('error:')) {
      const status = Number(action.slice('error:'.length));
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'NODE_QUEUE_AUTOMATIC_RETRY_FAILURE', type: 'invalid_request_error', code: 'model_not_found' },
        usage: { prompt_tokens: 1, completion_tokens: 0 } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (action.startsWith('submit:')) {
      const value = action.slice('submit:'.length);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `submit-${value}`, type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: Number(value) } } } }) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The answer.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
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

test('one node serializes delivery, queued chat and later delivery while another node completes independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-queue-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // The chat and the later delivery must be queued while the first delivery
  // is still running, so the master waits for the node to reach the provider.
  const firstTurnStarted = deferred();
  // The queue is read again once the first delivery settled.
  const firstTurnSettled = deferred();

  const master = await masterProvider((graphId) => [
    { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition: DEFINITION } },
    { id: 'send-a-1', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 1 } } },
    { id: 'send-b-2', name: 'graph_send', args: { graphId, nodeId: 'b', input: 'job', value: { n: 2 } } },
    { id: 'chat-a', name: 'graph_send', args: { graphId, nodeId: 'a', text: 'QUEUED_CHAT_AFTER_FIRST_STARTED' } },
    { id: 'send-a-3', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 3 } } },
    { id: 'inspect-queue-busy', name: 'graph_inspect', args: { graphId, query: 'queue', id: 'a' } },
    { id: 'inspect-executions-b', name: 'graph_inspect', args: { graphId, query: 'executions', id: 'b' } },
    { id: 'inspect-queue-done', name: 'graph_inspect', args: { graphId, query: 'queue', id: 'a' } },
    { id: 'inspect-executions-a', name: 'graph_inspect', args: { graphId, query: 'executions', id: 'a' } },
    { id: 'inspect-results', name: 'graph_inspect', args: { graphId, query: 'results' } },
  ], { 'chat-a': firstTurnStarted.promise, 'inspect-queue-done': firstTurnSettled.promise });

  const a = await nodeProvider(['submit:1', 'text', 'text', 'submit:3', 'text'], { holdFirst: true });
  const b = await nodeProvider(['submit:2', 'text']);

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'queue' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { queue: { secretRef: 'GRAPH_QUEUE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: a.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'b', provider: 'graph-node-b', modelId: 'b-model', baseUrl: b.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'queue-synthetic' }, extraArgs: ['--execute'] });
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    };

    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Queue two nodes.', requestId: 'node-queue' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    // The first delivery of node a is running at the provider.
    await Promise.race([
      a.arrived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the first node turn never reached the provider')), 60_000)),
    ]);
    firstTurnStarted.resolve();

    // The queue of node a while its first delivery runs: the delivery is
    // claimed, the chat and the later delivery wait their turn.
    await expect.poll(() => master.results.get('inspect-queue-busy'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const busy = JSON.parse(master.results.get('inspect-queue-busy')!) as { items: { kind: string; state: string }[] };
    expect(busy.items.map(item => [item.kind, item.state])).toEqual([
      ['delivery', 'claimed'], ['chat', 'queued'], ['delivery', 'queued'],
    ]);
    // The other node is not part of that queue.
    await expect.poll(() => master.results.get('inspect-executions-b'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const executionsB = JSON.parse(master.results.get('inspect-executions-b')!) as { items: { state: string }[] };
    expect(executionsB.items[0]).toMatchObject({ state: 'completed' });
    // The running turn has not seen the chat that arrived behind it.
    expect(a.turns()).toHaveLength(1);
    expect(JSON.stringify(a.turns()[0])).not.toContain('QUEUED_CHAT_AFTER_FIRST_STARTED');

    a.release();
    // The queue settles only after the last turn of the node did, so the
    // master only reads the finished queue once the node is done.
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
      return (view.body as { node: { status: string } }).node?.status;
    }, { timeout: 90_000, interval: 250 }).toBe('succeeded');
    firstTurnSettled.resolve();

    // The queue of node a once everything settled, in the order it was taken.
    await expect.poll(() => master.results.get('inspect-queue-done'), { timeout: 90_000, interval: 250 }).toBeTruthy();
    const done = JSON.parse(master.results.get('inspect-queue-done')!) as { items: { kind: string; state: string }[] };
    expect(done.items.map(item => [item.kind, item.state])).toEqual([
      ['delivery', 'done'], ['chat', 'done'], ['delivery', 'done'],
    ]);
    await expect.poll(() => master.results.get('inspect-executions-a'), { timeout: 90_000, interval: 250 }).toBeTruthy();
    const executionsA = JSON.parse(master.results.get('inspect-executions-a')!) as { items: { state: string }[] };
    expect(executionsA.items.map(item => item.state)).toEqual(['completed', 'completed', 'completed']);
    // The chat was answered after the delivery it queued behind.
    expect(a.turns()).toHaveLength(5);
    expect(JSON.stringify(a.turns()[2])).toContain('QUEUED_CHAT_AFTER_FIRST_STARTED');
    // The results of the graph are the two submitted values.
    await expect.poll(() => master.results.get('inspect-results'), { timeout: 90_000, interval: 250 }).toBeTruthy();
    const results = JSON.parse(master.results.get('inspect-results')!) as { value: { n: number } }[];
    expect(results.filter(item => [1, 3].includes(item.value.n)).map(item => item.value.n)).toEqual([1, 3]);
  } finally {
    a.release(); b.release();
    await daemon?.close(); await master.close(); await a.close(); await b.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

test('default resubmission is spent once and persisted failure totals survive reopen, while a node override permits two repairs', async () => {
  for (const override of [undefined, { automatic: 4, resubmit: 2 }]) {
    const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-resubmit-'));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

    const definition = {
      schemaVersion: 2,
      name: 'Resubmission',
      protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
      nodes: {
        a: {
          recipe: 'coder@1', model: 'a', task: 'Submit the assigned output for deliveries',
          inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
          ...(override ? { retry: override } : {}),
        },
      },
      modules: {}, edges: {}, inputs: {},
      outputs: { a: { from: 'a.out', protocol: 'ping' } },
    };
    const master = await masterProvider((graphId) => [
      { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition } },
      { id: 'send-a', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 0 } } },
    ], {});
    // Without the override the node may be repaired once; with it, twice.
    const a = await nodeProvider(override ? ['text', 'text', 'submit:7', 'text'] : ['text', 'text']);

    let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
    try {
      const configPath = join(root, 'graph.config.json');
      const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'queue' };
      await writeFile(configPath, JSON.stringify({
        version: 1,
        projects: [{ id: 'p', root: project }],
        credentials: { queue: { secretRef: 'GRAPH_QUEUE_KEY' } },
        models: { entries: [
          { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
          { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: a.baseUrl, contextWindow: 32000 },
        ] },
      }));
      const start = async () => launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'queue-synthetic' }, extraArgs: ['--execute'] });
      daemon = await start();
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await daemon!.request(path, init);
        return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
      };
      const operations = async () => {
        const view = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
        return (view.body as { operations: { state: string; retries_used: number; resubmits_used: number }[] }).operations;
      };

      const created = await request('/api/conversations', {
        method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Repair the work.', requestId: 'node-resubmit' }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);

      // The turn without its required output is repaired as often as the
      // allowance says, and the spent repair is part of the node's record.
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 90_000, interval: 250 })
        .toBe(override ? 'completed' : 'failed');
      expect((await operations())[0]).toMatchObject({ retries_used: 0, resubmits_used: override ? 2 : 1 });
      expect(a.turns()).toHaveLength(override ? 4 : 2);

      // A restart keeps the spent repair and does not ask the model again.
      await daemon.close();
      daemon = await start();
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 60_000, interval: 250 })
        .toBe(override ? 'completed' : 'failed');
      expect((await operations())[0]).toMatchObject({ retries_used: 0, resubmits_used: override ? 2 : 1 });
      expect(a.turns()).toHaveLength(override ? 4 : 2);
    } finally {
      await daemon?.close(); await master.close(); await a.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 240_000);

test('real provider failures spend two default automatic retries or four node overrides and remain spent after reopen', async () => {
  for (const retries of [2, 4]) {
    const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-retry-'));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

    const definition = {
      schemaVersion: 2,
      name: 'Provider failures',
      protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
      nodes: {
        a: {
          recipe: 'coder@1', model: 'a', task: 'Submit the assigned output for deliveries',
          inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
          ...(retries === 4 ? { retry: { automatic: 4, resubmit: 1 } } : {}),
        },
      },
      modules: {}, edges: {}, inputs: {},
      outputs: { a: { from: 'a.out', protocol: 'ping' } },
    };
    const master = await masterProvider((graphId) => [
      { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition } },
      { id: 'send-a', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 0 } } },
    ], {});
    // The model never answers: every call is a real provider failure.
    const a = await nodeProvider(Array.from({ length: 12 }, () => 'error:404'));

    let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
    try {
      const configPath = join(root, 'graph.config.json');
      const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'queue' };
      await writeFile(configPath, JSON.stringify({
        version: 1,
        projects: [{ id: 'p', root: project }],
        credentials: { queue: { secretRef: 'GRAPH_QUEUE_KEY' } },
        models: { entries: [
          { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
          { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: a.baseUrl, contextWindow: 32000 },
        ] },
      }));
      const start = async () => launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'queue-synthetic' }, extraArgs: ['--execute'] });
      daemon = await start();
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await daemon!.request(path, init);
        return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
      };
      const operations = async () => {
        const view = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
        return (view.body as { operations: { state: string; retries_used: number; resubmits_used: number }[] }).operations;
      };

      const created = await request('/api/conversations', {
        method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Fail the work.', requestId: 'node-retry' }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);

      // Every automatic retry the node is allowed is spent on a real
      // provider failure, and the spent retries stay on its record.
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 90_000, interval: 250 }).toBe('failed');
      expect((await operations())[0]).toMatchObject({ retries_used: retries, resubmits_used: 0 });
      expect(a.turns().length).toBeGreaterThanOrEqual(retries + 1);

      // A restart neither spends another retry nor asks the model again.
      const sent = a.turns().length;
      await daemon.close();
      daemon = await start();
      await expect.poll(async () => (await operations())[0]?.state, { timeout: 60_000, interval: 250 }).toBe('failed');
      expect((await operations())[0]).toMatchObject({ retries_used: retries, resubmits_used: 0 });
      expect(a.turns()).toHaveLength(sent);
    } finally {
      await daemon?.close(); await master.close(); await a.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 240_000);

test('a failed node retains its later input across reopen while another node runs, and explicit skip and resume release it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-retain-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const definition = {
    schemaVersion: 2,
    name: 'Retained input',
    protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
    nodes: {
      a: {
        recipe: 'coder@1', model: 'a', task: 'Submit the assigned output for deliveries',
        inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
        retry: { automatic: 0, resubmit: 0 },
      },
      b: {
        recipe: 'coder@1', model: 'b', task: 'Submit the assigned output for deliveries',
        inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
      },
    },
    modules: {}, edges: {}, inputs: {},
    outputs: { a: { from: 'a.out', protocol: 'ping' }, b: { from: 'b.out', protocol: 'ping' } },
  };
  // Before the restart the master reads the queue of the failed node; after
  // it, the same queue and the results of the work that was released.
  let phase: 'before' | 'after' = 'before';
  const queueStates = (results: Map<string, string>, id: string) => {
    const raw = results.get(id);
    if (!raw) return '';
    try {
      const items = (JSON.parse(raw) as { items?: { state: string }[] }).items ?? [];
      return items.map(item => item.state).join(',');
    } catch { return ''; }
  };
  const master = await masterProvider((graphId) => phase === 'before' ? [
    { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition } },
    { id: 'send-a-1', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 1 } } },
    { id: 'send-a-3', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: { n: 3 } } },
    { id: 'send-b-2', name: 'graph_send', args: { graphId, nodeId: 'b', input: 'job', value: { n: 2 } } },
    { id: 'inspect-queue-a', name: 'graph_inspect', args: { graphId, query: 'queue', id: 'a' },
      until: results => queueStates(results, 'inspect-queue-a') === 'failed,queued' },
  ] : [
    { id: 'inspect-queue-a-after', name: 'graph_inspect', args: { graphId, query: 'queue', id: 'a' } },
    { id: 'inspect-results-after', name: 'graph_inspect', args: { graphId, query: 'results' },
      until: results => /"n"\s*:\s*3/.test(results.get('inspect-results-after') ?? '') },
  ], {});
  // The first turn forgets the required output, the second one submits it.
  const a = await nodeProvider(['text', 'submit:3', 'text']);
  const b = await nodeProvider(['submit:2', 'text']);

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'queue' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { queue: { secretRef: 'GRAPH_QUEUE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: a.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'b', provider: 'graph-node-b', modelId: 'b-model', baseUrl: b.baseUrl, contextWindow: 32000 },
      ] },
    }));
    const start = async () => launchCli(root, { configPath, env: { GRAPH_QUEUE_KEY: 'queue-synthetic' }, extraArgs: ['--execute'] });
    daemon = await start();
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    };

    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Retain the later work.', requestId: 'node-retain' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // The first delivery of node a fails without its required output, the
    // second one waits in the queue, and node b finishes on its own.
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${master.graphId()}/nodes/a/run`);
      return (view.body as { node: { status: string } }).node?.status;
    }, { timeout: 90_000, interval: 250 }).toBe('failed');
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${master.graphId()}/nodes/b/run`);
      return (view.body as { node: { status: string } }).node?.status;
    }, { timeout: 90_000, interval: 250 }).toBe('succeeded');

    // The master reads the queue of node a: the failed delivery and the
    // delivery that still waits behind it.
    await request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Read the queue of the failed node.', requestId: 'read-queue' }),
    });
    await expect.poll(() => queueStates(master.results, 'inspect-queue-a'), { timeout: 90_000, interval: 250 }).toBe('failed,queued');
    const queue = JSON.parse(master.results.get('inspect-queue-a')!) as { items: { seq: number; kind: string; state: string }[] };
    expect(queue.items.map(item => [item.kind, item.state])).toEqual([['delivery', 'failed'], ['delivery', 'queued']]);
    expect(a.turns()).toHaveLength(1);

    // A restart keeps the failed delivery and the delivery behind it.
    await daemon.close();
    daemon = await start();
    phase = 'after';
    await request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Read the queue again.', requestId: 'read-queue-again' }),
    });
    await expect.poll(() => master.results.get('inspect-queue-a-after'), { timeout: 90_000, interval: 250 }).toBeTruthy();
    const afterRestart = JSON.parse(master.results.get('inspect-queue-a-after')!) as { items: { seq: number; kind: string; state: string }[] };
    expect(afterRestart.items.map(item => [item.kind, item.state])).toEqual([['delivery', 'failed'], ['delivery', 'queued']]);
    expect(a.turns()).toHaveLength(1);

    // Skipping the failed delivery and resuming the node releases the work
    // that was waiting behind it.
    const skipped = await request(`/api/tasks/${master.graphId()}/graph/control`, {
      method: 'POST', body: JSON.stringify({ action: 'skip', seq: afterRestart.items[0]!.seq }),
    });
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
    const resumed = await request(`/api/tasks/${master.graphId()}/graph/control`, {
      method: 'POST', body: JSON.stringify({ action: 'resume', nodeId: 'a' }),
    });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await expect.poll(() => /"n"\s*:\s*3/.test(master.results.get('inspect-results-after') ?? ''), { timeout: 90_000, interval: 250 }).toBe(true);
    expect(a.turns()).toHaveLength(3);

    // Work that was submitted cannot be sent again.
    const retried = await request(`/api/tasks/${master.graphId()}/graph/control`, {
      method: 'POST', body: JSON.stringify({ action: 'retry', seq: afterRestart.items[1]!.seq }),
    });
    expect(retried.status).toBe(400);
    expect((retried.body as { code?: string }).code).toBe('invalid_queue');
  } finally {
    await daemon?.close(); await master.close(); await a.close(); await b.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
