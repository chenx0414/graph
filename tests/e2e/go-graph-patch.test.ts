import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A patch that lands before a node submits changes the routing of that
 * submission, and the work that was already accepted survives a later patch
 * that removes the connection.
 *
 * A graph is not a frozen document: while a node is still working, the graph
 * can be changed. What a node submits afterwards follows the new revision, so
 * a connection that was switched off before the submit really did not carry
 * the value - and a connection that was switched on again does. A patch that
 * is based on a revision that is no longer current changes nothing, and a
 * patch that would drop a node with work still queued for it is refused until
 * that work is settled. Retiring the node afterwards keeps its history.
 *
 * The proof is a real daemon and a real graph: the master Agent creates the
 * graph, drives it with its own graph tools, and the nodes are real model
 * turns that really submit.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

const DEFINITION = {
  schemaVersion: 2,
  name: 'Patch routing',
  protocols: { data: { type: 'object' } },
  nodes: {
    a: {
      recipe: 'coder@1', model: 'a', task: 'Submit number seven',
      inputs: { job: { protocol: 'data' } }, outputs: { out: { protocol: 'data' } }, submission: { required: ['out'] },
    },
    b: {
      recipe: 'coder@1', model: 'b', task: 'Process the already accepted number',
      inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {},
    },
  },
  modules: {},
  edges: { link: { from: 'a.out', to: 'b.job', enabled: true } },
  inputs: {}, outputs: {},
};

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
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The graph is as expected.' }, finish_reason: 'stop' }],
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
    graphId: () => graphId,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/**
 * A node model. A node that has work in front of it submits its output, and
 * answers once the work is done. The first turn of the sender can be held, so
 * the graph can be patched while the node is still working.
 */
async function nodeProvider(options: { hold?: boolean; submit?: boolean } = {}) {
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
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const withTools = (body.tools ?? []).length > 0;
    if (options.hold && withTools && !heldOnce) {
      heldOnce = true;
      entered();
      await held;
    }
    // A new delivery is a new piece of work: the node submits its output
    // once per delivery, and answers the turn that follows the submit.
    const history = (body.messages ?? []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n');
    const deliveries = (history.match(/NEW DELIVERY:/g) ?? []).length;
    const alreadySubmitted = (body.messages ?? []).filter(message => (message.tool_calls ?? []).some(call => call.function?.name === 'submit')).length;
    const submit = options.submit !== false && deliveries > alreadySubmitted;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (submit) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 7 } } } }) } }] }, finish_reason: null }] }));
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
    arrived,
    release: () => release(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('a patch before the submit changes the routing of that submit, and accepted work survives a later patch that removes the connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-patch-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const sender = await nodeProvider({ hold: true, submit: true });
  const receiver = await nodeProvider({ submit: false });
  let plan: (graphId: string) => MasterCall[] = () => [];
  const master = await masterProvider(graphId => plan(graphId));
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const notes: Record<string, unknown> = {};

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const control = async (graphId: string, body: Record<string, unknown>) => {
    const response = await request(`/api/tasks/${graphId}/graph/control`, {
      method: 'POST', body: JSON.stringify(body),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response;
  };
  const nodeRun = async (graphId: string, nodeId: string) => {
    const view = await request(`/api/tasks/${graphId}/nodes/${nodeId}/run`);
    return view.body as {
      node: { status: string };
      instance: { id: string };
      timing: { inProgress: boolean };
      entries: unknown[];
      operations: { state: string }[];
    };
  };
  /** The node has run at least this many times, and none of those runs is in flight. */
  const nodeSettled = async (graphId: string, nodeId: string, count: number) => {
    const run = await nodeRun(graphId, nodeId);
    const operations = run.operations ?? [];
    return operations.length >= count && !operations.some(operation => operation.state === 'running');
  };
  /** The node is working right now. */
  const nodeWorking = async (graphId: string, nodeId: string) => {
    const run = await nodeRun(graphId, nodeId);
    return (run.operations ?? []).some(operation => operation.state === 'running');
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
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'patch' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { patch: { secretRef: 'GRAPH_PATCH_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'a', provider: 'graph-node-a', modelId: 'a-model', baseUrl: sender.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'b', provider: 'graph-node-b', modelId: 'b-model', baseUrl: receiver.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PATCH_KEY: 'patch-synthetic' }, extraArgs: ['--execute'] });

    plan = (graphId: string): MasterCall[] => [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: DEFINITION } },
      {
        id: 'send-a-1', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: {} },
        before: async () => { await control(graphId, { action: 'pause', nodeId: 'b' }); },
      },
      {
        id: 'patch-disable', name: 'graph_patch',
        args: { graphId, baseRevision: 1, changes: { reason: 'Disable before the actual submit arrives', patch: { edges: { link: { enabled: false } } } } },
        before: async () => {
          // The node is working when the patch lands: the submit has not
          // arrived yet.
          await waitFor(async () => nodeWorking(graphId, 'a'));
          notes.aRunning = true;
        },
      },
      {
        id: 'inspect-edge-1', name: 'graph_inspect', args: { graphId, query: 'edge', id: 'link' },
        before: async () => {
          sender.release();
          await waitFor(async () => nodeSettled(graphId, 'a', 1));
          // Nothing reached the other node: it was not asked for a turn.
          notes.receiverTurns = receiver.turns().length;
        },
      },
      { id: 'patch-enable', name: 'graph_patch', args: { graphId, baseRevision: 2, changes: { reason: 'Enable a new future submission', patch: { edges: { link: { enabled: true } } } } } },
      { id: 'send-a-2', name: 'graph_send', args: { graphId, nodeId: 'a', input: 'job', value: {} } },
      {
        id: 'inspect-edge-2', name: 'graph_inspect', args: { graphId, query: 'edge', id: 'link' },
        before: async () => { await waitFor(async () => nodeSettled(graphId, 'a', 2)); },
      },
      { id: 'patch-remove', name: 'graph_patch', args: { graphId, baseRevision: 3, changes: { reason: 'Remove only the future connection', patch: { edges: { link: null } } } } },
      { id: 'patch-stale', name: 'graph_patch', args: { graphId, baseRevision: 3, changes: { reason: 'Stale name edit', patch: { name: 'stale' } } } },
      { id: 'inspect-revision', name: 'graph_inspect', args: { graphId, query: 'revision' } },
      { id: 'patch-ambiguous', name: 'graph_patch', args: { graphId, baseRevision: 4, changes: { reason: 'Ambiguous', definition: DEFINITION, patch: {} } } },
      { id: 'patch-not-object', name: 'graph_patch', args: { graphId, baseRevision: 4, changes: { reason: 'Not an object', patch: [] } } },
      { id: 'patch-unknown-protocol', name: 'graph_patch', args: { graphId, baseRevision: 4, changes: { reason: 'Unknown protocol', patch: { nodes: { b: { inputs: { job: { protocol: 'missing' } } } } } } } },
      { id: 'inspect-revision-2', name: 'graph_inspect', args: { graphId, query: 'revision' } },
      { id: 'inspect-queue-1', name: 'graph_inspect', args: { graphId, query: 'queue' } },
      {
        id: 'patch-pending-work', name: 'graph_patch',
        args: { graphId, baseRevision: 4, changes: { reason: 'Drop accepted work', patch: { nodes: { b: null } }, retire: ['b'] } },
        before: async () => {
          notes.bInstance = (await nodeRun(graphId, 'b')).instance.id;
          notes.bRun = await nodeRun(graphId, 'b');
        },
      },
      {
        id: 'patch-retire', name: 'graph_patch',
        args: { graphId, baseRevision: 4, changes: { reason: 'Retire explicitly after completion', patch: { nodes: { b: null } }, retire: ['b'] } },
        before: async () => {
          await control(graphId, { action: 'resume', nodeId: 'b' });
          await waitFor(async () => receiver.turns().length > 0);
          await waitFor(async () => nodeSettled(graphId, 'b', 1));
          notes.bHistory = (await nodeRun(graphId, 'b')).entries;
        },
      },
      {
        id: 'inspect-b', name: 'graph_inspect', args: { graphId, query: 'summary' },
        before: async () => { notes.bAfter = await nodeRun(graphId, 'b'); },
      },
      {
        id: 'final-inspect', name: 'graph_inspect', args: { graphId, query: 'summary' },
        before: async () => {
          await control(graphId, { action: 'complete' });
          await waitFor(async () => {
            const view = await request(`/api/tasks/${graphId}`);
            return (view.body as { phase?: string }).phase === 'completed';
          });
        },
      },
    ];

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Patch the graph while it works.', requestId: 'graph-patch' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await expect.poll(() => master.results.get('final-inspect'), { timeout: 180_000, interval: 250 }).toBeTruthy();

    // Every step of the plan ran.
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // The node really was working when the patch landed.
    expect(notes.aRunning).toBe(true);

    // The submission that arrived after the connection was switched off did
    // not travel: the edge has no delivery at all.
    const edgeOne = JSON.parse(master.results.get('inspect-edge-1')!) as { deliveries: unknown[] };
    expect(edgeOne.deliveries).toEqual([]);
    // The other node was never asked: nothing reached it.
    expect(notes.receiverTurns).toBe(0);

    // The delivery that was accepted is still queued for the other node: it
    // has not run yet, and nobody was asked about it.
    const queue = JSON.parse(master.results.get('inspect-queue-1')!) as { items: { nodeId: string; state: string }[] };
    expect(queue.items.filter(item => item.nodeId === 'b')).toMatchObject([{ state: 'queued' }]);

    // The connection that was switched on again carried the next submission.
    const edgeTwo = JSON.parse(master.results.get('inspect-edge-2')!) as { deliveries: { value: { n: number }; receiver: { state: string } }[] };
    expect(edgeTwo.deliveries).toMatchObject([{ value: { n: 7 }, receiver: { state: 'queued' } }]);

    // A patch that is based on a revision that is no longer current changes
    // nothing, and the model is told which revision is the current one.
    expect(master.results.get('patch-stale')).toContain('current revision is 4');

    // The three broken patches are refused and leave the revision alone.
    expect(master.results.get('patch-ambiguous')).toContain('Supply exactly one full definition or local patch');
    expect(master.results.get('patch-not-object')).toContain('Graph patch must be a JSON object');
    expect(master.results.get('patch-unknown-protocol')).toBeTruthy();
    expect(master.results.get('inspect-revision-2')).toBe(master.results.get('inspect-revision'));

    // A patch that would drop a node with work queued for it is refused, and
    // the node keeps its instance.
    expect(master.results.get('patch-pending-work')).toContain('Cannot remove b');
    expect((notes.bAfter as { instance: { id: string } }).instance.id).toBe(notes.bInstance);

    // The accepted work runs once the node is released, and the value that
    // was accepted is the one the node was given.
    expect(receiver.turns()).toHaveLength(1);
    expect(JSON.stringify(receiver.turns()[0])).toContain('\\"n\\":7');

    // Retiring the node afterwards keeps its instance and its history.
    expect(master.results.get('patch-retire')).toContain('"revision":5');
    const bAfter = notes.bAfter as { node: { status: string }; instance: { id: string }; entries: unknown[] };
    expect(bAfter.node.status).toBe('retired');
    expect(bAfter.instance.id).toBe(notes.bInstance);
    expect(bAfter.entries).toEqual(notes.bHistory);

    // The graph settled on the revision the retire published.
    const summary = JSON.parse(master.results.get('final-inspect')!) as { phase: string; revision: number };
    expect(summary.phase).toBe('completed');
    expect(summary.revision).toBe(5);
  } finally {
    sender.release(); receiver.release();
    await daemon?.close(); await master.close(); await sender.close(); await receiver.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
