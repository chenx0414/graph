import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A definition is refused as a whole, and the refusal names the rule it broke.
 *
 * A graph definition is a contract with the runtime: the nodes, the ports,
 * the protocols and the acceptance criteria all have to mean something before
 * any work starts. One broken rule refuses the whole definition - it is not
 * a graph with one bad corner, and it is not a graph at all. The refusal
 * names the rule so the model can fix the definition instead of guessing.
 *
 * The proof is a real daemon: the master Agent tries the broken definitions
 * through its own graph tool, and the daemon refuses each one by name. No
 * half-built graph is left behind, and no node is ever asked to work.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall {
  id: string;
  name: string;
  args: unknown;
  /** The host-side work this call depends on, done before the call goes out. */
  before?: () => Promise<void>;
}

/**
 * The master Agent. It plays the plan in order and records what every tool
 * call answered, so the test reads the definition the way the model read it.
 */
async function masterProvider(plan: (graphId: string) => MasterCall[]) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  let graphId = '';
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
      if (found) graphId = found[1]!;
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
    const next = plan(graphId).find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The definitions are as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    try {
      await next.before?.();
    } catch (error) {
      // A broken step ends the turn: the test reads the reason instead of
      // waiting for a plan that can no longer run.
      failures.push(error instanceof Error ? error.message : String(error));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Stopped.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    failures,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/**
 * The node model. A definition that is refused must never reach a node, so
 * this provider only records that it was asked - and answers nothing.
 *
 * With `echo` it behaves like a node that hands back what it was given: the
 * delivery it was handed is submitted unchanged.
 */
async function nodeProvider(options: { echo?: boolean } = {}) {
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
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (withTools && options.echo && deliveries.length > submitted) {
      const payload = JSON.parse(deliveries[deliveries.length - 1]!) as { value: unknown };
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: payload.value } } }) } }] }, finish_reason: null }] }));
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

const BASE = {
  schemaVersion: 2,
  name: 'Definition refusal',
  protocols: {
    'implementation-request': {
      type: 'object',
      required: ['goal'],
      properties: { goal: { type: 'string' } },
    },
    'code-result': {
      type: 'object',
      required: ['repository', 'commit', 'artifact'],
      properties: {
        repository: { type: 'string' },
        commit: { type: 'string' },
        artifact: { type: 'object' },
      },
    },
  },
  nodes: {
    worker: {
      recipe: 'coder@1', model: 'sender', task: 'Implement the request',
      inputs: { task: { protocol: 'implementation-request' } },
      outputs: { result: { protocol: 'code-result' } },
      submission: { required: ['result'] },
    },
  },
  modules: {},
  edges: {},
  inputs: { task: { to: 'worker.task', protocol: 'implementation-request' } },
  outputs: { result: { from: 'worker.result', protocol: 'code-result' } },
};

/** The base definition with one node field replaced. */
const withNode = (fields: Record<string, unknown>) => ({
  ...BASE,
  nodes: { worker: { ...BASE.nodes.worker, ...fields } },
});

interface Refusal {
  /** The name of the rule this definition breaks. */
  name: string;
  /** The definition the daemon has to refuse. */
  definition: unknown;
  /** The part of the daemon's own refusal that names the rule. */
  fragment: string;
}

const REFUSALS: Refusal[] = [
  { name: 'a node declares a host command', definition: withNode({ recipe: undefined, command: { run: 'node', args: ['--version'] } }), fragment: 'operation module' },
  { name: 'a node declares a host command without a run', definition: withNode({ command: { run: '' } }), fragment: 'operation module' },
  { name: 'a node declares a null host command', definition: withNode({ command: null }), fragment: 'operation module' },
  { name: 'a graph input names an unknown endpoint', definition: { ...BASE, inputs: { task: { to: 'worker.missing', protocol: 'implementation-request' } } }, fragment: 'worker.missing' },
  { name: 'a workspace path escapes its base', definition: withNode({ workspace: { base: 'project', path: '../outside' } }), fragment: 'workspace.path' },
  { name: 'a workspace path is absolute', definition: withNode({ workspace: { base: 'project', path: '/absolute' } }), fragment: 'workspace.path' },
  { name: 'a workspace path holds a backslash', definition: withNode({ workspace: { base: 'project', path: 'some\\path' } }), fragment: 'workspace.path' },
  { name: 'a workspace names an unknown base', definition: withNode({ workspace: { base: 'elsewhere' } }), fragment: 'workspace requires base' },
  { name: 'an access policy names unknown commands', definition: withNode({ access: { mode: 'standard', commands: 'shell' } }), fragment: 'access.commands' },
  { name: 'an access policy names an unknown filesystem field', definition: withNode({ access: { mode: 'standard', filesystem: { unknown: true } } }), fragment: 'access.filesystem' },
  { name: 'an access policy names no mode', definition: withNode({ access: { filesystem: { read: 'host' } } }), fragment: 'access requires mode' },
  { name: 'an edge leaves enablement out', definition: { ...BASE, edges: { link: { from: 'worker.result', to: 'worker.task', enabled: undefined } } }, fragment: 'enabled' },
  { name: 'an edge sets enablement to null', definition: { ...BASE, edges: { link: { from: 'worker.result', to: 'worker.task', enabled: null } } }, fragment: 'enabled' },
  { name: 'an edge sets enablement to a number', definition: { ...BASE, edges: { link: { from: 'worker.result', to: 'worker.task', enabled: 0 } } }, fragment: 'enabled' },
  { name: 'an edge sets enablement to one', definition: { ...BASE, edges: { link: { from: 'worker.result', to: 'worker.task', enabled: 1 } } }, fragment: 'enabled' },
  { name: 'an edge sets enablement to a string', definition: { ...BASE, edges: { link: { from: 'worker.result', to: 'worker.task', enabled: 'false' } } }, fragment: 'enabled' },
  { name: 'an edge sets enablement to an object', definition: { ...BASE, edges: { link: { from: 'worker.result', to: 'worker.task', enabled: {} } } }, fragment: 'enabled' },
  { name: 'an edge sets enablement to an array', definition: { ...BASE, edges: { link: { from: 'worker.result', to: 'worker.task', enabled: [] } } }, fragment: 'enabled' },
  { name: 'an edge names an unknown output endpoint', definition: { ...BASE, edges: { 'worker-review': { from: 'worker.nope', to: 'worker.task', enabled: true } } }, fragment: 'worker.nope' },
  {
    name: 'an edge connects two protocol versions',
    definition: {
      ...BASE,
      protocols: { ...BASE.protocols, ping: { type: 'object' } },
      nodes: {
        worker: {
          ...BASE.nodes.worker,
          inputs: { task: { protocol: 'implementation-request' }, ping: { protocol: 'ping' } },
          outputs: { result: { protocol: 'code-result' }, ping2: { protocol: 'ping', version: 2 } },
        },
      },
      edges: { mismatch: { from: 'worker.ping2', to: 'worker.ping', enabled: true } },
    },
    fragment: 'ping',
  },
  { name: 'an edge has a blank id', definition: { ...BASE, edges: { '': { from: 'worker.result', to: 'worker.task', enabled: true } } }, fragment: 'blank' },
  { name: 'the schema version is not supported', definition: { ...BASE, schemaVersion: 1 }, fragment: 'schemaVersion' },
  { name: 'an output names an undeclared protocol', definition: withNode({ outputs: { result: { protocol: 'nope' } } }), fragment: 'nope' },
  { name: 'a submission requires an undeclared output', definition: withNode({ submission: { required: ['ghost'] } }), fragment: 'ghost' },
  { name: 'a node names no model', definition: withNode({ model: '' }), fragment: 'model' },
  { name: 'a node names a model that is not a name', definition: withNode({ model: 7 }), fragment: 'model' },
  { name: 'a node names no model at all', definition: withNode({ model: null }), fragment: 'model' },
  { name: 'a node declares a negative retry limit', definition: withNode({ retry: { automatic: -1 } }), fragment: 'retry' },
  { name: 'a node declares a fractional retry limit', definition: withNode({ retry: { resubmit: 0.5 } }), fragment: 'retry' },
  { name: 'a node declares a retry that is not an object', definition: withNode({ retry: [] }), fragment: 'retry' },
  { name: 'a node declares an unknown retry limit', definition: withNode({ retry: { unknown: 1 } }), fragment: 'retry' },
  { name: 'a node declares empty instructions', definition: withNode({ instructions: '' }), fragment: 'instructions' },
  { name: 'a node declares blank instructions', definition: withNode({ instructions: ' \n\t' }), fragment: 'instructions' },
  { name: 'a node declares instructions that are not text', definition: withNode({ instructions: 7 }), fragment: 'instructions' },
  { name: 'a node declares null instructions', definition: withNode({ instructions: null }), fragment: 'instructions' },
  { name: 'the graph defaults declare a negative quota', definition: { ...BASE, defaults: { budget: { tokens: -1 } } }, fragment: 'defaults' },
  { name: 'the graph defaults declare a fractional quota', definition: { ...BASE, defaults: { budget: { tokens: 1.5 } } }, fragment: 'defaults' },
  { name: 'the graph defaults declare a quota without naming one', definition: { ...BASE, defaults: { budget: {} } }, fragment: 'defaults' },
  { name: 'the graph defaults declare another quota key', definition: { ...BASE, defaults: { budget: { tokens: 1, other: 2 } } }, fragment: 'defaults' },
  { name: 'the graph defaults declare a quota that is not an object', definition: { ...BASE, defaults: { budget: [] } }, fragment: 'defaults' },
  { name: 'the graph defaults declare a negative retry limit', definition: { ...BASE, defaults: { retry: { automatic: -1 } } }, fragment: 'defaults' },
  { name: 'the graph defaults name no model', definition: { ...BASE, defaults: { model: '' } }, fragment: 'defaults' },
  { name: 'the acceptance has no criterion', definition: { ...BASE, acceptance: [{}] }, fragment: 'Acceptance' },
  { name: 'the acceptance repeats an id', definition: { ...BASE, acceptance: [{ id: 'a', description: 'inspect', kind: 'human' }, { id: 'a', description: 'again', kind: 'human' }] }, fragment: 'Acceptance' },
  { name: 'the acceptance criterion has no description', definition: { ...BASE, acceptance: [{ id: 'a', kind: 'human' }] }, fragment: 'Acceptance' },
  { name: 'the acceptance criterion has an unknown kind', definition: { ...BASE, acceptance: [{ id: 'a', description: 'inspect', kind: 'anything' }] }, fragment: 'Acceptance' },
  { name: 'the acceptance check names no module', definition: { ...BASE, acceptance: [{ id: 'a', description: 'test', kind: 'check', module: 'missing' }] }, fragment: 'Acceptance' },
  { name: 'the acceptance review names no node', definition: { ...BASE, acceptance: [{ id: 'a', description: 'review', kind: 'review', node: 'missing' }] }, fragment: 'Acceptance' },
  { name: 'the acceptance criterion carries an unknown field', definition: { ...BASE, acceptance: [{ id: 'a', description: 'inspect', kind: 'human', passed: true }] }, fragment: 'Acceptance' },
  { name: 'a protocol promises a type nobody knows', definition: { ...BASE, protocols: { ...BASE.protocols, bad: { type: 'not-a-type' } } }, fragment: 'invalid schema' },
  { name: 'a node carries legacy context', definition: withNode({ context: { purpose: 'review', sourceNode: 'worker' } }), fragment: 'Node worker' },
  { name: 'a node carries legacy predecessors', definition: withNode({ dependsOn: ['worker'] }), fragment: 'Node worker' },
  { name: 'a node carries a legacy condition', definition: withNode({ when: { node: 'review', equals: true } }), fragment: 'Node worker' },
  { name: 'a node carries a legacy container', definition: withNode({ container: 'bundle' }), fragment: 'Node worker' },
];

test('a definition that breaks one rule is refused by name and leaves no graph behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-definitions-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const node = await nodeProvider();
  // Every refusal names its rule, and no two definitions share a name: a graph
  // that was really created would be visible in the task list.
  const master = await masterProvider(() => REFUSALS.map((refusal, index) => ({
    id: `reject-${index}`,
    name: 'graph_create',
    args: { requestId: `reject-${index}`, definition: { ...(refusal.definition as object), name: refusal.name } },
  })));
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'definitions' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { definitions: { secretRef: 'GRAPH_DEFINITIONS_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_DEFINITIONS_KEY: 'definitions-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Try the broken definitions.', requestId: 'graph-definitions' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => REFUSALS.every((_, index) => master.results.has(`reject-${index}`)), { timeout: 180_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // Every broken definition is refused, and the refusal names the rule.
    // The violations are collected first, so one run names every rule the
    // daemon let through.
    const violations: string[] = [];
    for (const [index, refusal] of REFUSALS.entries()) {
      const result = master.results.get(`reject-${index}`)!;
      if (!result.includes(refusal.fragment)) {
        violations.push(`${refusal.name}: the refusal does not name "${refusal.fragment}" (${result.slice(0, 200)})`);
      }
      // A refused definition is not a graph: it has no id to work with.
      if (result.includes('"graphId"')) {
        violations.push(`${refusal.name}: the daemon built a graph anyway`);
      }
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

    // No half-built graph is left behind.
    const tasks = await request('/api/tasks');
    const names = new Set(REFUSALS.map(refusal => refusal.name));
    const created = (tasks.body as { request: string }[]).filter(task => names.has(task.request));
    expect(created, JSON.stringify(created)).toEqual([]);

    // A refused definition never reaches a node: nobody was asked to work.
    expect(node.turns()).toHaveLength(0);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

const PROTOCOL = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'items'],
  properties: {
    status: { type: 'string', enum: ['approved', 'rework'] },
    items: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
  },
};

const ROUND_TRIP = {
  schemaVersion: 2,
  name: 'Protocol round trip',
  protocols: { data: PROTOCOL },
  nodes: {
    worker: {
      recipe: 'coder@1', model: 'sender', task: 'Submit the received value unchanged',
      inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      submission: { required: ['result'] },
    },
  },
  modules: {},
  edges: {},
  inputs: { job: { to: 'worker.job', protocol: 'data' } },
  outputs: { result: { from: 'worker.result', protocol: 'data' } },
};

test('a value that breaks the receiving protocol is refused before any node is asked, and a valid value survives unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-protocol-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const node = await nodeProvider({ echo: true });
  const notes: Record<string, unknown> = {};
  const master = await masterProvider(graphId => [
    { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: ROUND_TRIP } },
    { id: 'bad-status', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'made-up', items: [1] } } },
    { id: 'bad-empty', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'approved', items: [] } } },
    { id: 'bad-element', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'approved', items: [0] } } },
    { id: 'bad-extra', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'approved', items: [1], extra: true } } },
    {
      id: 'queue', name: 'graph_inspect', args: { graphId, query: 'queue' },
      before: async () => { notes.turnsAfterRefusals = node.turns().length; },
    },
    { id: 'good', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { status: 'approved', items: [1] } } },
    {
      id: 'results', name: 'graph_inspect', args: { graphId, query: 'results' },
      before: async () => {
        // The node really ran and really submitted the value it was given.
        await waitFor(async () => {
          const run = await request(`/api/tasks/${graphId}/nodes/worker/run`);
          const operations = (run.body as { operations: { state: string }[] }).operations ?? [];
          return operations.length >= 1 && !operations.some(operation => operation.state === 'running');
        });
      },
    },
    {
      id: 'summary', name: 'graph_inspect', args: { graphId, query: 'summary' },
      before: async () => {
        const completed = await request(`/api/tasks/${graphId}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'complete' }) });
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        await waitFor(async () => {
          const view = await request(`/api/tasks/${graphId}`);
          return (view.body as { phase?: string }).phase === 'completed';
        });
      },
    },
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
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'protocol' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { protocol: { secretRef: 'GRAPH_PROTOCOL_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PROTOCOL_KEY: 'protocol-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Deliver the values.', requestId: 'graph-protocol' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('summary'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // Every malformed value is refused, and the refusal names the field that
    // broke the protocol.
    const refused = ['bad-status', 'bad-empty', 'bad-element', 'bad-extra'];
    for (const id of refused) {
      const result = master.results.get(id)!;
      expect(result, id).toContain('worker.job');
      expect(result, id).not.toContain('"delivery"');
    }

    // Nothing was queued: the values never became work.
    const queue = JSON.parse(master.results.get('queue')!) as { items: unknown[] };
    expect(queue.items).toEqual([]);
    // And no node was asked about them.
    expect(notes.turnsAfterRefusals).toBe(0);

    // The valid value went through the node unchanged.
    const results = JSON.parse(master.results.get('results')!) as { value: unknown }[];
    expect(results).toMatchObject([{ value: { status: 'approved', items: [1] } }]);
    // The node was asked exactly about the value that was accepted.
    expect(node.turns().length).toBeGreaterThan(0);

    // The graph finished.
    const summary = JSON.parse(master.results.get('summary')!) as { phase: string };
    expect(summary.phase).toBe('completed');
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
