import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A node id is literal text, and a submission that already landed cannot be
 * taken back by a retry.
 *
 * The ids here are the ones a wildcard would eat: a bracket, a star and a
 * question mark. A node called `bracket[1]` is the node called `bracket[1]`,
 * not a pattern that matches something else. When such a node declares a
 * deliverable it never wrote, the attempt fails for that reason - but the
 * output it had already submitted is a fact, and a retry cannot spend it
 * again.
 *
 * The proof is a real daemon and a real graph: the master Agent creates the
 * graphs and drives them with its own graph tools, and the node really runs
 * and really submits.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

const NODE_IDS = ['plain', 'bracket[1]', 'star*', 'question?'] as const;

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
async function masterProvider(plan: () => MasterCall[], onResult: (id: string, content: string) => void) {
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
      onResult(message.tool_call_id ?? '', content);
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
 * The node model. It plays the plan of the whole run: the first attempt does
 * not submit, the retry does, and the turn that follows a submit answers.
 */
async function nodeProvider(actions: string[]) {
  const requests: ChatBody[] = [];
  let index = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const withTools = (body.tools ?? []).length > 0;
    const action = withTools ? (actions[index++] ?? 'text') : 'text';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (action.startsWith('submit:')) {
      const marker = action.slice('submit:'.length);
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { marker } } } }) } }] }, finish_reason: null }] }));
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

test('literal node identities keep a submitted retry generation immutable even when the declared deliverable later fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-identity-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // Three turns per node: the attempt that does not submit, the retry that
  // does, and the turn that follows it.
  const node = await nodeProvider(NODE_IDS.flatMap(id => ['text', `submit:${id}`, 'text']));
  const created: string[] = [];
  const controls: { action: string; status: number; code: string | undefined; message: string | undefined }[] = [];
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const control = async (graphId: string, body: Record<string, unknown>) => {
    const response = await request(`/api/tasks/${graphId}/graph/control`, {
      method: 'POST', body: JSON.stringify(body),
    });
    const parsed = response.body as { code?: string; message?: string };
    controls.push({ action: String(body.action ?? ''), status: response.status, code: parsed.code, message: parsed.message });
    return response;
  };
  const waitFor = async (read: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await read()) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('the graph never reached the expected state');
  };
  const phaseOf = async (graphId: string) => {
    const view = await request(`/api/tasks/${graphId}`);
    return (view.body as { phase?: string }).phase;
  };
  const nodeRuns = async (graphId: string, nodeId: string) => {
    // The node id is literal text, so it has to travel percent-encoded: a
    // question mark in the path would otherwise start the query string.
    const view = await request(`/api/tasks/${graphId}/nodes/${encodeURIComponent(nodeId)}/run`);
    return (view.body as { operations: { state: string }[] }).operations ?? [];
  };
  const seqOf = (result: string | undefined) => {
    const queue = JSON.parse(result ?? '{}') as { items?: { seq: number }[] };
    return queue.items?.[0]?.seq;
  };

  const master = await masterProvider(() => {
    const calls: MasterCall[] = [];
    for (let index = 0; index < NODE_IDS.length; index += 1) {
      const id = NODE_IDS[index]!;
      const graphId = created[index] ?? '';
      const definition = {
        schemaVersion: 2,
        name: `Literal identity ${id}`,
        protocols: { data: { type: 'object' } },
        nodes: {
          [id]: {
            recipe: 'coder@1', model: 'sender', task: 'Submit and publish the declared file',
            inputs: { job: { protocol: 'data' } }, outputs: { out: { protocol: 'data' } }, submission: { required: ['out'] },
            workspace: { base: 'project' }, retry: { automatic: 0, resubmit: 0 },
            deliverable: { path: 'missing.md', namespace: 'plans', name: 'missing' },
          },
        },
        modules: {}, edges: {}, inputs: {},
        outputs: { result: { from: `${id}.out`, protocol: 'data' } },
      };
      /** The node has run this many times, and none of those runs is in flight. */
      const settled = async (count: number) => {
        await waitFor(async () => {
          const operations = await nodeRuns(graphId, id);
          return operations.length >= count && !operations.some(operation => operation.state === 'running');
        });
      };
      calls.push(
        { id: `create-${index}`, name: 'graph_create', args: { requestId: `create-${index}`, definition } },
        { id: `send-${index}`, name: 'graph_send', args: { graphId, nodeId: id, input: 'job', value: {} } },
        {
          id: `queue-${index}`, name: 'graph_inspect', args: { graphId, query: 'queue' },
          before: async () => { await settled(1); },
        },
        {
          id: `blocked-${index}`, name: 'graph_inspect', args: { graphId, query: 'summary' },
          before: async () => {
            // The completion is asked for, and the graph waits on the work that
            // failed.
            const completed = await control(graphId, { action: 'complete' });
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            await waitFor(async () => (await phaseOf(graphId)) === 'blocked');
          },
        },
        {
          id: `retry-${index}`, name: 'graph_inspect', args: { graphId, query: 'queue' },
          before: async () => {
            // The retry runs the node again.
            const retried = await control(graphId, { action: 'retry', seq: seqOf(master.results.get(`queue-${index}`)) });
            expect(retried.status, JSON.stringify(retried.body)).toBe(200);
            await settled(2);
          },
        },
        { id: `results-${index}`, name: 'graph_inspect', args: { graphId, query: 'results' } },
        {
          id: `retry-again-${index}`, name: 'graph_inspect', args: { graphId, query: 'queue' },
          before: async () => {
            // A retry cannot spend a submission that already landed.
            await control(graphId, { action: 'retry', seq: seqOf(master.results.get(`retry-${index}`)) });
          },
        },
        {
          id: `skipped-${index}`, name: 'graph_inspect', args: { graphId, query: 'summary' },
          before: async () => {
            // Skipping the failed work lets the graph finish.
            const skipped = await control(graphId, { action: 'skip', seq: seqOf(master.results.get(`retry-${index}`)) });
            expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
            await waitFor(async () => (await phaseOf(graphId)) === 'completed');
          },
        },
      );
    }
    return calls;
  }, (id, content) => {
    const match = /^create-(\d+)$/.exec(id);
    if (!match) return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) created[Number(match[1])] = found[1]!;
  });

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'identity' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { identity: { secretRef: 'GRAPH_IDENTITY_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_IDENTITY_KEY: 'identity-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Exercise the literal node identities.', requestId: 'graph-identity' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    // The plan plays one graph after the other: every graph is done before
    // the next one starts.
    await expect.poll(() => NODE_IDS.every((_, index) => master.results.has(`skipped-${index}`)), { timeout: 120_000, interval: 250 }).toBe(true);

    // Every step of every graph ran.
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    for (const [index, id] of NODE_IDS.entries()) {
      // The attempt that did not submit failed, and it is the first
      // generation of that work.
      const first = JSON.parse(master.results.get(`queue-${index}`)!) as { items: { state: string; generation: number }[] };
      expect(first.items, id).toMatchObject([{ state: 'failed', generation: 0 }]);
      // The graph waits on that failed work.
      const blocked = JSON.parse(master.results.get(`blocked-${index}`)!) as { phase: string };
      expect(blocked.phase, id).toBe('blocked');
      // The retry ran the node again; the node submitted, and the deliverable
      // it promised was never written.
      const second = JSON.parse(master.results.get(`retry-${index}`)!) as { items: { state: string; generation: number; reason: string }[] };
      expect(second.items, id).toMatchObject([{ state: 'failed', generation: 1 }]);
      expect(second.items[0]!.reason, id).toContain('never written');
      // The output it had already submitted is a fact.
      const results = JSON.parse(master.results.get(`results-${index}`)!) as { value: { marker: string } }[];
      expect(results, id).toMatchObject([{ value: { marker: id } }]);
      // A retry cannot spend a submission that already landed.
      const again = JSON.parse(master.results.get(`retry-again-${index}`)!) as { items: { state: string; generation: number }[] };
      expect(again.items, id).toMatchObject([{ state: 'failed', generation: 1 }]);
      // Skipping the failed work lets the graph finish.
      const skipped = JSON.parse(master.results.get(`skipped-${index}`)!) as { phase: string };
      expect(skipped.phase, id).toBe('completed');
    }

    // The retry of a submitted work was refused, with the daemon's own code.
    const refusals = controls.filter(record => record.status !== 200);
    expect(refusals).toHaveLength(NODE_IDS.length);
    for (const record of refusals) {
      expect(record.code, JSON.stringify(record)).toBe('invalid_queue');
      expect(record.message, JSON.stringify(record)).toContain('Submitted work');
    }

    // The node really ran: three turns per node, and no more.
    expect(node.turns()).toHaveLength(NODE_IDS.length * 3);
  } finally {
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
