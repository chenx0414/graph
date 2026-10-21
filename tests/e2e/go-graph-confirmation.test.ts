import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A confirmed draft becomes a graph that really runs.
 *
 * The master Agent proposes a graph; the draft it proposes is a real
 * document - the console can draw it, its edges name their endpoints and
 * their protocols. The user confirms it, and the confirmation creates the
 * feature task: the nodes are admitted and idle, and nothing runs until
 * an input is delivered. Confirming the same draft twice does not wake
 * the master twice.
 *
 * A draft that is not a native graph cannot become a feature at all: it is
 * refused, and there is nothing to confirm.
 *
 * The proof is a real daemon: the master Agent proposes through its own
 * tool, the user confirms over HTTP, and the nodes are real model turns.
 */

const run = promisify(execFile);

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall {
  id: string;
  name: string;
  /** The arguments, resolved when the call goes out - not when the plan is read. */
  args: unknown | (() => unknown);
  /** The host-side work this call depends on, done before the call goes out. */
  before?: () => Promise<void>;
}

/**
 * The master Agent. It plays the plan in order and records what every tool
 * call answered, so the test reads the graph the way the model read it.
 */
async function masterProvider(plan: () => MasterCall[]) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  let turns = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    turns += 1;
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The graph is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    try {
      await next.before?.();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Stopped.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const args = typeof next.args === 'function' ? next.args() : next.args;
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    failures,
    turns: () => turns,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/**
 * The node model. The value it was handed says which node it is: the first
 * node was handed the start value, the second the value the first published.
 */
async function nodeProvider() {
  const requests: ChatBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const withTools = (body.tools ?? []).length > 0;
    const history = (body.messages ?? []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n');
    const deliveries = [...history.matchAll(/NEW DELIVERY: (\{.*\})/g)].map(match => match[1]!);
    const submitted = (body.messages ?? []).filter(message => (message.tool_calls ?? []).some(call => call.function?.name === 'submit')).length;
    let value: { n?: number } = {};
    if (deliveries.length > submitted) {
      const payload = JSON.parse(deliveries[deliveries.length - 1]!) as { value?: { n?: number } };
      value = payload.value ?? {};
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (withTools && deliveries.length > submitted) {
      // The first node publishes forty two; the second, which was handed that
      // value, publishes forty three.
      const published = value.n === 0 ? { n: 42 } : { n: 43 };
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: published } } }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 10 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    turns: () => requests.filter(body => (body.tools ?? []).length > 0),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const DEFINITION = {
  schemaVersion: 2,
  name: 'chain',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: {
      recipe: 'coder@1', model: 'sender', task: 'Publish the first number',
      inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
    },
    b: {
      recipe: 'coder@1', model: 'sender', task: 'Publish the second number',
      inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
    },
  },
  modules: {
    gate: {
      type: 'router', trigger: 'each', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } },
      rules: [{ when: 'in.n > 0', emit: { out: '$in' } }],
    },
  },
  edges: { ab: { from: 'a.out', to: 'b.in', enabled: true } },
  acceptance: [{ id: 'works', description: 'The chain runs through', kind: 'human' }],
};

const PROPOSAL = {
  requirementVersion: 1,
  summary: 'A two node chain',
  acceptance: [{ id: 'works', description: 'The chain runs through', checkNode: 'b' }],
  definition: DEFINITION,
};

test('a confirmed draft becomes a graph that runs, and confirming it twice does not wake the master twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-confirmation-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), '# chain\n');
  // The target branch is a real branch of a real repository.
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await run('git', args, { cwd: project });
  }

  const node = await nodeProvider();
  const confirmed: string[] = [];
  const master = await masterProvider(() => [
    { id: 'propose', name: 'propose_graph', args: { requestId: 'proposal-v2', proposal: PROPOSAL } },
    {
      id: 'send-input', name: 'graph_send',
      args: () => ({ graphId: confirmed[0] ?? '', nodeId: 'a', input: 'in', value: { n: 0 } }),
      before: async () => {
        // The confirmation creates the feature task; the master sends into it.
        await waitFor(async () => confirmed.length > 0);
      },
    },
    {
      id: 'executions', name: 'graph_inspect',
      args: () => ({ graphId: confirmed[0] ?? '', query: 'executions' }),
      before: async () => {
        await waitFor(async () => {
          const view = await request(`/api/tasks/${confirmed[0]}/nodes/b/run`);
          const operations = (view.body as { operations?: { state: string }[] }).operations ?? [];
          return operations.length >= 1 && !operations.some(operation => operation.state === 'running');
        });
      },
    },
    { id: 'edge', name: 'graph_inspect', args: () => ({ graphId: confirmed[0] ?? '', query: 'edge', id: 'ab' }) },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const waitFor = async (read: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await read()) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('the graph never reached the expected state');
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'confirmation' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { confirmation: { secretRef: 'GRAPH_CONFIRMATION_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_CONFIRMATION_KEY: 'confirmation-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Make a two node chain.', requestId: 'graph-confirmation' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const conversationId = (started.body as { conversationId: string }).conversationId;

    // The master proposed the graph.
    await expect.poll(() => master.results.has('propose'), { timeout: 120_000, interval: 250 }).toBeTruthy();
    const receipt = JSON.parse(master.results.get('propose')!) as { proposalVersion: number; draftRevision: number };
    expect(receipt.proposalVersion).toBe(1);
    expect(receipt.draftRevision).toBeGreaterThan(0);

    // The draft is a real document: the console can draw it.
    const draft = await request(`/api/conversations/${conversationId}/draft-graph`);
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const draftView = draft.body as {
      nodes: { id: string; kind: string; status: string; action: string }[];
      layout: { edges: { id: string; source: string; target: string }[] };
      interfaces: { edgeId: string; from: string; to: string; protocol: string; latest: unknown }[];
    };
    expect(draftView.nodes.map(node => node.id)).toEqual(['a', 'b', 'gate']);
    expect(draftView.nodes.find(node => node.id === 'gate')).toMatchObject({ kind: 'module', status: 'draft', action: 'route' });
    expect(draftView.layout.edges).toMatchObject([{ id: 'ab', source: 'a', target: 'b' }]);
    expect(draftView.interfaces).toMatchObject([{ edgeId: 'ab', from: 'a.out', to: 'b.in', protocol: 'ping', latest: null }]);

    // The user confirms the draft.
    const accepted = await request(`/api/conversations/${conversationId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ proposalVersion: receipt.proposalVersion, draftRevision: receipt.draftRevision, targetBranch: 'main', requestId: 'confirm' }),
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const taskId = (accepted.body as { taskId: string }).taskId;
    confirmed.push(taskId);

    // The confirmed graph is the same document, and its nodes wait for work.
    const running = await request(`/api/tasks/${taskId}/graph`);
    expect(running.status, JSON.stringify(running.body)).toBe(200);
    const runningView = running.body as {
      nodes: { id: string; status: string }[];
      layout: { edges: unknown[] };
      interfaces: { edgeId: string; from: string; to: string }[];
    };
    expect(runningView.nodes.map(node => node.id)).toEqual(['a', 'b', 'gate']);
    expect(runningView.nodes.every(node => node.status === 'idle')).toBe(true);
    expect(runningView.layout.edges).toEqual(draftView.layout.edges);
    expect(runningView.interfaces).toMatchObject([{ edgeId: 'ab', from: 'a.out', to: 'b.in' }]);

    // The master was woken and sent the input; the chain really ran.
    await expect.poll(() => master.results.has('edge'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // The send landed on the named input, and it landed as work to do.
    const sent = JSON.parse(master.results.get('send-input')!) as {
      delivery: { toEndpoint: string; value: unknown; state: string };
      queue?: { state: string };
    };
    expect(sent.delivery).toMatchObject({ toEndpoint: 'a.in', value: { n: 0 }, state: 'accepted' });
    expect(sent.queue).toMatchObject({ state: 'queued' });

    const executions = JSON.parse(master.results.get('executions')!) as { items: { nodeId: string; state: string }[] };
    expect(executions.items.filter(item => item.nodeId === 'a')).toMatchObject([{ state: 'completed' }]);
    expect(executions.items.filter(item => item.nodeId === 'b')).toMatchObject([{ state: 'completed' }]);
    const edge = JSON.parse(master.results.get('edge')!) as { deliveries: { value: unknown }[] };
    expect(edge.deliveries).toMatchObject([{ value: { n: 42 } }]);

    // Confirming the same draft again does not wake the master again.
    const turns = master.turns();
    await request(`/api/conversations/${conversationId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ proposalVersion: receipt.proposalVersion, draftRevision: receipt.draftRevision, targetBranch: 'main', requestId: 'confirm' }),
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(master.turns()).toBe(turns);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test('a draft that is not a native graph cannot become a feature', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-legacy-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), '# legacy\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await run('git', args, { cwd: project });
  }

  const master = await masterProvider(() => [
    {
      id: 'propose-legacy', name: 'propose_graph',
      args: {
        requestId: 'proposal-old',
        proposal: {
          requirementVersion: 1, summary: 'An old plan',
          acceptance: [{ id: 'works', description: 'The check passes', checkNode: 'check' }],
          nodes: [
            { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
            { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
          ],
        },
      },
    },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'legacy' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { legacy: { secretRef: 'GRAPH_LEGACY_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_LEGACY_KEY: 'legacy-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'An old plan.', requestId: 'graph-legacy' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const conversationId = (started.body as { conversationId: string }).conversationId;

    await expect.poll(() => master.results.has('propose-legacy'), { timeout: 120_000, interval: 250 }).toBeTruthy();

    // The old shaped draft is refused, and the model learns which field is missing.
    expect(master.results.get('propose-legacy')).toContain('proposal.definition');
    expect(master.results.get('propose-legacy')).toContain('must have required properties');

    // There is nothing to confirm.
    const accepted = await request(`/api/conversations/${conversationId}/confirm`, {
      method: 'POST', body: JSON.stringify({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' }),
    });
    expect(accepted.status).toBe(400);
    expect((accepted.body as { code?: string }).code).toBe('stale_proposal');

    // And no feature task was created.
    const tasks = await request('/api/tasks');
    const graphs = (tasks.body as { request: string; phase: string }[]).filter(task => task.request === 'An old plan');
    expect(graphs, JSON.stringify(graphs)).toEqual([]);
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
