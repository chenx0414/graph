import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A node reads the graph it is working on.
 *
 * The overview a node starts from is a preview: it shows the shape of the
 * graph, not every object in it. A node that needs the whole of one named
 * object - its task, its private guidance - has to be able to read it, and a
 * node that needs to see the whole of a section has to be able to page
 * through it instead of asking for everything at once.
 *
 * And the definition a node reads is the one its own execution was started
 * on: a graph that changes while a node is working does not change under
 * that node, and the next execution does see the change.
 *
 * The proof is a real daemon, a real graph of sixty-one nodes, a real worker
 * and a real patch: the worker really reads a named object in full, really
 * pages through the section, and really reads the changed definition in its
 * next execution.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface Step {
  id: string;
  name: string;
  args: unknown;
  before?: () => Promise<void>;
}

/**
 * A scripted model. It plays the plan in order and records what every tool
 * call answered, so the test reads the session the way the model read it.
 *
 * The plan is asked for the number of answers already given, so a session
 * that runs twice can play a different plan the second time.
 */
async function scriptedProvider(plan: (answered: number) => Step[]) {
  const results = new Map<string, string>();
  const requests: ChatBody[] = [];
  let answered = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
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
    const next = plan(answered).find(call => !spoken.has(call.id));
    answered += 1;
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The graph is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    await next.before?.();
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const DETAIL = 'DETAIL-OF-LAST-NODE-' + 'x'.repeat(1500);
const PRIVATE_GUIDANCE = 'OTHER_NODE_PRIVATE_GUIDANCE ' + 'x'.repeat(1500);

/** A graph with sixty named nodes beside the one that works. */
function definition() {
  const nodes: Record<string, unknown> = {};
  for (let index = 0; index < 60; index += 1) {
    nodes[`side-${index}`] = {
      recipe: 'coder@1',
      task: index === 59 ? DETAIL : 'Other task ' + 'x'.repeat(1500),
      instructions: PRIVATE_GUIDANCE,
      inputs: {}, outputs: {}, submission: {},
    };
  }
  nodes.work = { recipe: 'coder@1', model: 'worker', task: 'Inspect the graph definition', inputs: {}, outputs: {}, submission: {} };
  return {
    schemaVersion: 2,
    name: 'Graph reads',
    protocols: { data: { type: 'object' } },
    nodes,
    modules: {},
    edges: {},
    acceptance: [],
  };
}

test('a node reads the named object whole, pages through the section, and reads the change in its next execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-read-graph-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'project\n');

  // The worker reads: first the named object, then the page of the section,
  // and then - in the execution that follows the patch - the named object again.
  const worker = await scriptedProvider((answered) => {
    // The first read waits for the change to be published: the graph is
    // already at its second revision by the time the node asks for the
    // definition, and the node must still read the one it started on.
    if (answered === 0) return [{ id: 'read-graph-0', name: 'read_graph', args: { section: 'nodes', id: 'side-59' },
      before: async () => { await waitForPatch(); } }];
    if (answered === 1) return [{ id: 'page-graph-0', name: 'read_graph', args: { section: 'nodes', after: 50, limit: 7 } }];
    if (answered === 3) return [{ id: 'read-graph-1', name: 'read_graph', args: { section: 'nodes', id: 'side-59' } }];
    return [];
  });

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const master = await scriptedProvider(() => {
    const graphId = graphIdOf(master.results.get('create') ?? '');
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: definition() } },
      { id: 'chat', name: 'graph_send', args: { graphId, nodeId: 'work', text: 'Inspect the graph definition' } },
      { id: 'patch', name: 'graph_patch', args: { graphId, baseRevision: 1,
          changes: { reason: 'Next execution configuration', patch: { nodes: { 'side-59': { task: 'NEXT EXECUTION CONFIGURATION' } } } } },
        before: async () => { await waitForWorkerTurn(); } },
      { id: 'chat-again', name: 'graph_send', args: { graphId, nodeId: 'work', text: 'Inspect the updated definition' } },
    ];
  });
  const graphIdOf = (content: string) => {
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    return found ? found[1]! : '';
  };

  const configPath = join(root, 'graph.config.json');
  const credential = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'read' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { read: { secretRef: 'GRAPH_READ_KEY' } },
    models: { entries: [
      { ...credential, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      { ...credential, id: 'worker', provider: 'graph-worker', modelId: 'worker-model', baseUrl: worker.baseUrl, contextWindow: 32000 },
    ] },
  }));

  // The change is published while the first execution is still running: the
  // running node keeps the definition it started on, and the change belongs
  // to the execution that comes after it.
  const waitForWorkerTurn = async () => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (worker.requests.length >= 1) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('the worker never started its first execution');
  };

  // The worker reads only once the change is published.
  const waitForPatch = async () => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (master.results.has('patch')) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('the change was never published');
  };

  daemon = await launchCli(root, { configPath, env: { GRAPH_READ_KEY: 'read-synthetic' }, extraArgs: ['--execute'] });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Have the graph inspected.', requestId: 'read-graph' }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => master.results.has('chat-again'), { timeout: 240_000, interval: 250 }).toBeTruthy();
    // The second execution really ran and really read.
    await expect.poll(() => worker.results.has('read-graph-1'), { timeout: 240_000, interval: 250 }).toBeTruthy();
    expect(master.results.has('create'), 'the master never created a graph').toBeTruthy();

    // The named object comes back whole: the private guidance the overview
    // left out is in the answer.
    const named = JSON.parse(worker.results.get('read-graph-0')!) as {
      revision: number; section: string; total: number;
      items: { id: string; value: { task: string; instructions: string } }[];
    };
    expect(named).toMatchObject({ revision: 1, section: 'nodes', total: 61 });
    expect(named.items).toHaveLength(1);
    expect(named.items[0]!.id).toBe('side-59');
    expect(named.items[0]!.value.task).toBe(DETAIL);
    expect(named.items[0]!.value.instructions).toContain('OTHER_NODE_PRIVATE_GUIDANCE');

    // The section pages: seven objects, the whole count, and where the next
    // page starts.
    const page = JSON.parse(worker.results.get('page-graph-0')!) as {
      revision: number; total: number; nextAfter: number; items: { id: string }[];
    };
    expect(page).toMatchObject({ revision: 1, total: 61, nextAfter: 57 });
    expect(page.items.map(item => item.id)).toEqual(['side-54', 'side-55', 'side-56', 'side-57', 'side-58', 'side-59', 'side-6']);

    // The next execution reads the changed definition.
    const next = JSON.parse(worker.results.get('read-graph-1')!) as {
      revision: number; items: { id: string; value: { task: string } }[];
    };
    expect(next).toMatchObject({ revision: 2, items: [{ id: 'side-59', value: { task: 'NEXT EXECUTION CONFIGURATION' } }] });
  } finally {
    await daemon?.close();
    await master.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
