import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A module is a decision the graph makes on its own.
 *
 * A router module reads the values that land on its inputs, matches them
 * against its rules, and lands what it emitted on the edges that carry it.
 * The rules are a small language, not code: they can ask whether an input
 * is there, read a field of it, and compare it. What they cannot do is
 * reach into the runtime - a rule that names something that is not there
 * simply does not match.
 *
 * The proof is a real daemon and real modules: the master Agent sends the
 * values through its own graph tools, the modules really evaluate, and the
 * edges really carry what the rules emitted.
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
 * call answered, so the test reads the graph the way the model read it.
 */
async function masterProvider(plan: () => MasterCall[], onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      onResult?.(message.tool_call_id ?? '', content);
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
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The modules are as expected.' }, finish_reason: 'stop' }],
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
 * The node model. A node that has no required output finishes its turn by
 * answering, and the answer carries the value it was given.
 */
async function nodeProvider() {
  const requests: ChatBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
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

const DATA = { protocol: 'data' };

test('each routing cascades through modules, keeps the order of the values and leaves disabled edges empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-modules-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const definition = {
    schemaVersion: 2,
    name: 'Each cascade',
    protocols: { data: { type: 'object' } },
    nodes: {
      worker: {
        recipe: 'coder@1', model: 'sender', task: 'Read the received input and acknowledge it',
        inputs: { job: DATA }, outputs: {}, submission: {},
      },
    },
    modules: {
      gate: {
        type: 'router', trigger: 'each', inputs: { review: DATA }, outputs: { rework: DATA, approved: DATA },
        rules: [
          { when: 'review.passed == false', emit: { rework: '$review' } },
          { when: 'review.passed == true', emit: { approved: '$review' } },
        ],
      },
      second: {
        type: 'router', trigger: 'each', inputs: { review: DATA }, outputs: { out: DATA },
        rules: [{ when: 'review.passed == false', emit: { out: '$review' } }],
      },
    },
    edges: {
      rework: { from: 'gate.rework', to: 'worker.job', enabled: true },
      approve: { from: 'gate.approved', to: 'worker.job', enabled: true },
      cascade: { from: 'gate.rework', to: 'second.review', enabled: true },
      off: { from: 'gate.approved', to: 'second.review', enabled: false },
    },
    inputs: {},
    outputs: { result: { from: 'second.out', protocol: 'data' } },
  };

  const failed = { passed: false, reason: 'nope', reviewedCommit: 'abc' };
  const passed = { passed: true, reason: 'ok', reviewedCommit: 'def' };

  const node = await nodeProvider();
  const graphs: string[] = [];
  const master = await masterProvider(() => {
    const graphId = graphs[0] ?? '';
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition } },
      { id: 'pause-worker', name: 'graph_control', args: { graphId, action: 'pause', nodeId: 'worker' } },
      { id: 'send-unmatched', name: 'graph_send', args: { graphId, nodeId: 'gate', input: 'review', value: { passed: 'not matched' } } },
      {
        id: 'queue-empty', name: 'graph_inspect', args: { graphId, query: 'queue' },
        before: async () => {
          // The module really looked at the value and matched no rule.
          await waitForTransitions(graphId, 'gate', 1);
        },
      },
      { id: 'send-failed', name: 'graph_send', args: { graphId, nodeId: 'gate', input: 'review', value: failed } },
      { id: 'send-passed', name: 'graph_send', args: { graphId, nodeId: 'gate', input: 'review', value: passed } },
      {
        id: 'queue', name: 'graph_inspect', args: { graphId, query: 'queue' },
        before: async () => { await waitForTransitions(graphId, 'gate', 3); },
      },
      { id: 'edge-rework', name: 'graph_inspect', args: { graphId, query: 'edge', id: 'rework' } },
      { id: 'edge-off', name: 'graph_inspect', args: { graphId, query: 'edge', id: 'off' } },
      { id: 'module-values', name: 'graph_inspect', args: { graphId, query: 'module_values', id: 'second' } },
      { id: 'module', name: 'graph_inspect', args: { graphId, query: 'module', id: 'gate' } },
      { id: 'results', name: 'graph_inspect', args: { graphId, query: 'results' } },
      { id: 'resume-worker', name: 'graph_control', args: { graphId, action: 'resume', nodeId: 'worker' } },
      {
        id: 'executions', name: 'graph_inspect', args: { graphId, query: 'executions' },
        before: async () => { await waitForWorker(graphId); },
      },
      {
        id: 'summary', name: 'graph_inspect', args: { graphId, query: 'summary' },
        before: async () => {
          const completed = await request(`/api/tasks/${graphId}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'complete' }) });
          expect(completed.status, JSON.stringify(completed.body)).toBe(200);
          await waitFor(async () => (await request(`/api/tasks/${graphId}`)).body !== undefined
            && ((await request(`/api/tasks/${graphId}`)).body as { phase?: string }).phase === 'completed');
        },
      },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });
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
  /** The module evaluated at least this many times. */
  const waitForTransitions = async (graphId: string, moduleId: string, count: number) => {
    await waitFor(async () => {
      const view = await request(`/api/tasks/${graphId}/graph/modules/${moduleId}`);
      const transitions = (view.body as { transitions?: unknown[] }).transitions ?? [];
      return transitions.length >= count;
    });
  };
  /** The node ran twice and is not running any more. */
  const waitForWorker = async (graphId: string) => {
    await waitFor(async () => {
      const view = await request(`/api/tasks/${graphId}/nodes/worker/run`);
      const operations = (view.body as { operations?: { state: string }[] }).operations ?? [];
      return operations.length >= 2 && !operations.some(operation => operation.state === 'running');
    });
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'modules' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { modules: { secretRef: 'GRAPH_MODULES_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_MODULES_KEY: 'modules-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Route the reviews.', requestId: 'graph-modules' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('summary'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // A value that matched no rule became no work at all.
    const empty = JSON.parse(master.results.get('queue-empty')!) as { items: unknown[] };
    expect(empty.items).toEqual([]);

    // The values that did match kept their order on the queue.
    const queue = JSON.parse(master.results.get('queue')!) as { items: { payload: { value: unknown } }[] };
    expect(queue.items.map(item => item.payload.value)).toEqual([failed, passed]);

    // The rule that matched carried the value on its own edge.
    const rework = JSON.parse(master.results.get('edge-rework')!) as { deliveries: { source: string; value: unknown }[] };
    expect(rework.deliveries).toMatchObject([{ source: 'module', value: failed }]);
    // The edge that was switched off carried nothing.
    const off = JSON.parse(master.results.get('edge-off')!) as { deliveries: unknown[] };
    expect(off.deliveries).toEqual([]);

    // The module that was cascaded into really received the value.
    const values = JSON.parse(master.results.get('module-values')!) as { inputs: { name: string; value: unknown; delivered: boolean }[] };
    expect(values.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'review', value: failed, delivered: true })]));

    // Every evaluation says which rule it matched.
    const module = JSON.parse(master.results.get('module')!) as { transitions: { reason: string; ruleVersion: number }[] };
    expect(module.transitions.map(item => item.reason)).toEqual(['no rule matched', 'review.passed == false', 'review.passed == true']);
    expect(module.transitions.every(item => item.ruleVersion === 1)).toBe(true);

    // The cascaded output is on the graph.
    const results = JSON.parse(master.results.get('results')!) as { value: unknown }[];
    expect(results).toMatchObject([{ value: failed }]);

    // The node was asked once for each value that reached it.
    expect(node.turns()).toHaveLength(2);
    expect(JSON.stringify(node.turns()[0])).toContain('nope');
    expect(JSON.stringify(node.turns()[1])).toContain('ok');
    const executions = JSON.parse(master.results.get('executions')!) as { items: { nodeId: string; state: string }[] };
    expect(executions.items.filter(item => item.nodeId === 'worker')).toMatchObject([{ state: 'completed' }, { state: 'completed' }]);

    // The graph finished.
    const summary = JSON.parse(master.results.get('summary')!) as { phase: string };
    expect(summary.phase).toBe('completed');
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

const EXPRESSIONS: { when: string; inputs: Record<string, Record<string, unknown>>; matches: boolean }[] = [
  { when: '$exists(review)', inputs: { review: { passed: true } }, matches: true },
  { when: '$missing(review)', inputs: { other: {} }, matches: true },
  { when: 'review.passed == false', inputs: { review: { passed: false } }, matches: true },
  { when: 'review.passed == false', inputs: { review: { passed: true } }, matches: false },
  { when: 'review.passed == false', inputs: { other: {} }, matches: false },
  { when: 'review.count > 3', inputs: { review: { count: 5 } }, matches: true },
  { when: 'review.count >= 5', inputs: { review: { count: 5 } }, matches: true },
  { when: 'review.name == "ok"', inputs: { review: { name: 'ok' } }, matches: true },
  { when: '$exists(a) && ($missing(b) || b.ok == true)', inputs: { a: {}, b: { ok: true } }, matches: true },
  { when: '$exists(a) && ($missing(b) || b.ok == true)', inputs: { a: {} }, matches: true },
  { when: '$exists(a) && ($missing(b) || b.ok == true)', inputs: { b: { ok: true } }, matches: false },
  { when: '!$missing(a)', inputs: { a: {} }, matches: true },
  { when: 'this.constructor', inputs: { other: {} }, matches: false },
  { when: 'this.constructor', inputs: { this: { constructor: 'anything' } }, matches: true },
  { when: 'ghost.field == 1', inputs: { other: {} }, matches: false },
];

test('rule expressions read the values, tell presence from absence and merge matching outputs in declaration order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-rules-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const node = await nodeProvider();
  const graphs: string[] = [];
  const master = await masterProvider(() => {
    const calls: MasterCall[] = [];
    EXPRESSIONS.forEach((row, index) => {
      const graphId = graphs[index] ?? '';
      const definition = {
        schemaVersion: 2,
        name: `Expression ${index}`,
        protocols: { data: { type: 'object' } },
        nodes: {},
        modules: {
          rule: {
            type: 'router', trigger: 'each',
            inputs: { review: DATA, other: DATA, a: DATA, b: DATA, this: DATA },
            outputs: { out: DATA },
            rules: [{ when: row.when, emit: { out: { marker: 'matched' } } }],
          },
        },
        edges: {},
        inputs: {},
        outputs: { result: { from: 'rule.out', protocol: 'data' } },
      };
      calls.push({ id: `create-${index}`, name: 'graph_create', args: { requestId: `create-${index}`, definition } });
      let sent = 0;
      for (const [input, value] of Object.entries(row.inputs)) {
        sent += 1;
        calls.push({ id: `send-${index}-${input}`, name: 'graph_send', args: { graphId, nodeId: 'rule', input, value } });
      }
      calls.push({
        id: `results-${index}`, name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'rule', sent); },
      });
    });
    return calls;
  }, (id, content) => {
    const match = /^create-(\d+)$/.exec(id);
    if (!match) return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[Number(match[1])] = found[1]!;
  });
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
  const waitForTransitions = async (graphId: string, moduleId: string, count: number) => {
    await waitFor(async () => {
      const view = await request(`/api/tasks/${graphId}/graph/modules/${moduleId}`);
      const transitions = (view.body as { transitions?: unknown[] }).transitions ?? [];
      return transitions.length >= count;
    });
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'rules' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { rules: { secretRef: 'GRAPH_RULES_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_RULES_KEY: 'rules-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Try the expressions.', requestId: 'graph-rules' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => EXPRESSIONS.every((_, index) => master.results.has(`results-${index}`)), { timeout: 300_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // Every expression matches exactly what it claims to match.
    const violations: string[] = [];
    for (const [index, row] of EXPRESSIONS.entries()) {
      const results = JSON.parse(master.results.get(`results-${index}`)!) as { value: unknown }[];
      const matched = results.length > 0;
      if (matched !== row.matches) {
        violations.push(`${row.when}: expected ${row.matches ? 'a match' : 'no match'}, got ${JSON.stringify(results)}`);
      }
      if (matched) {
        const last = results[results.length - 1]!;
        if (JSON.stringify(last.value) !== JSON.stringify({ marker: 'matched' })) {
          violations.push(`${row.when}: the emitted value is ${JSON.stringify(last.value)}`);
        }
      }
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test('a once module keeps the inputs it holds, judges again only when it is reopened, and never replays its output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-once-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const definition = {
    schemaVersion: 2,
    name: 'Once join',
    protocols: { data: { type: 'object' } },
    nodes: {},
    modules: {
      join: {
        type: 'router', trigger: 'once', requiredInputs: ['a', 'b'],
        inputs: { a: DATA, b: DATA, control: DATA },
        outputs: { pair: DATA },
        control: { reopen: 'control' },
        rules: [{ when: '$exists(a) && $exists(b)', emit: { pair: { first: '$a', second: '$b' } } }],
      },
    },
    edges: {},
    inputs: {},
    outputs: { result: { from: 'join.pair', protocol: 'data' } },
  };

  const node = await nodeProvider();
  const graphs: string[] = [];
  const master = await masterProvider(() => {
    const graphId = graphs[0] ?? '';
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition } },
      { id: 'send-a-1', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'a', value: { passed: true } } },
      {
        id: 'results-1', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 1); },
      },
      { id: 'send-b-1', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'b', value: { passed: false } } },
      {
        id: 'results-2', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 2); },
      },
      { id: 'send-a-2', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'a', value: { passed: false } } },
      {
        id: 'results-3', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 3); },
      },
      { id: 'values-1', name: 'graph_inspect', args: { graphId, query: 'module_values', id: 'join' } },
      { id: 'reopen', name: 'graph_control', args: { graphId, action: 'reopen', moduleId: 'join' } },
      {
        id: 'results-4', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 4); },
      },
      { id: 'send-b-2', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'b', value: { passed: true } } },
      {
        id: 'results-5', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 5); },
      },
      { id: 'send-control', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'control', value: { reopen: true } } },
      {
        id: 'results-6', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 6); },
      },
      { id: 'values-2', name: 'graph_inspect', args: { graphId, query: 'module_values', id: 'join' } },
      { id: 'send-a-3', name: 'graph_send', args: { graphId, nodeId: 'join', input: 'a', value: { passed: true } } },
      {
        id: 'results-7', name: 'graph_inspect', args: { graphId, query: 'results' },
        before: async () => { await waitForTransitions(graphId, 'join', 7); },
      },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });
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
  const waitForTransitions = async (graphId: string, moduleId: string, count: number) => {
    await waitFor(async () => {
      const view = await request(`/api/tasks/${graphId}/graph/modules/${moduleId}`);
      const transitions = (view.body as { transitions?: unknown[] }).transitions ?? [];
      return transitions.length >= count;
    });
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'once' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { once: { secretRef: 'GRAPH_ONCE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_ONCE_KEY: 'once-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Join the values.', requestId: 'graph-once' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('results-7'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    const read = (id: string) => JSON.parse(master.results.get(id)!) as { value: unknown }[];

    // One input is not enough: the module waits for the one it declared.
    expect(read('results-1')).toEqual([]);
    // Both are there: it judges once and pairs them.
    expect(read('results-2')).toMatchObject([{ value: { first: { passed: true }, second: { passed: false } } }]);
    // A latched module does not judge again, so nothing is replayed.
    expect(read('results-3')).toHaveLength(1);

    // The module kept the values it was given, including the updated one.
    const values = JSON.parse(master.results.get('values-1')!) as { inputs: { name: string; value: unknown; delivered: boolean }[] };
    expect(values.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'a', value: { passed: false }, delivered: true }),
      expect.objectContaining({ name: 'b', value: { passed: false }, delivered: true }),
    ]));

    // Reopening the module is not a judgment: it clears the latch and keeps the inputs.
    expect(read('results-4')).toHaveLength(1);
    // The next delivery judges again, with the values the module holds.
    expect(read('results-5')).toMatchObject([{}, { value: { first: { passed: false }, second: { passed: true } } }]);

    // A delivered control reopens the module without producing anything.
    expect(read('results-6')).toHaveLength(2);
    const afterControl = JSON.parse(master.results.get('values-2')!) as { inputs: { name: string; value: unknown; delivered: boolean }[] };
    expect(afterControl.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'control', delivered: false }),
      expect.objectContaining({ name: 'a', value: { passed: false } }),
      expect.objectContaining({ name: 'b', value: { passed: true } }),
    ]));

    // And the next delivery judges once more.
    expect(read('results-7')).toMatchObject([{}, {}, { value: { first: { passed: true }, second: { passed: true } } }]);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
