import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A graph that holds another graph.
 *
 * A reusable graph is instantiated inside a larger one, so its members become
 * 'outer/inner/work' and the console has to draw the container, the instance
 * and the members as one picture. The edge that returns work to the beginning
 * has to reach the member it belongs to, not the container around it.
 *
 * The picture is also a fact: adding a node leaves the nodes that were there
 * where they were, and removing it again leaves them there too. A graph that
 * repacks its neighbours on every change cannot be read while it is worked on.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Point { x: number; y: number }
interface Rect extends Point { width: number; height: number }
interface GraphView {
  nodes: { id: string; kind: string; container?: string }[];
  containers: { id: string; parent?: string }[];
  layout: { positions: Record<string, Rect>; edges: { id: string; source: string; target: string; points?: Point[] }[] };
}

const worker = {
  recipe: 'coder@1', model: 'local', task: 'Do the work.',
  inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
  submission: { required: ['result'] },
};

const INNER = {
  schemaVersion: 2, name: 'Inner', protocols: { data: { type: 'object' } },
  nodes: { work: worker, review: worker }, modules: {},
  edges: { review: { from: 'work.result', to: 'review.job', enabled: true } },
  inputs: { job: { to: 'work.job', protocol: 'data' } },
  outputs: { result: { from: 'review.result', protocol: 'data' } },
};

const OUTER = {
  schemaVersion: 2, name: 'Outer', protocols: { data: { type: 'object' } },
  nodes: {}, modules: {}, edges: {},
  templates: { inner: { version: 1, definition: INNER } },
  instances: { inner: { template: 'inner', version: 1 } },
  inputs: { job: { to: 'inner.job', protocol: 'data' } },
  outputs: { result: { from: 'inner.result', protocol: 'data' } },
};

const DEFINITION = {
  schemaVersion: 2, name: 'Nested rework layout', protocols: { data: { type: 'object' } },
  nodes: {},
  modules: {
    gate: {
      type: 'router', trigger: 'each',
      inputs: { review: { protocol: 'data' } },
      outputs: { rework: { protocol: 'data' }, passed: { protocol: 'data' } },
      rules: [
        { when: 'review.passed == false', emit: { rework: '$review' } },
        { when: 'review.passed == true', emit: { passed: '$review' } },
      ],
    },
  },
  edges: {
    judgment: { from: 'outer.result', to: 'gate.review', enabled: true },
    rework: { from: 'gate.rework', to: 'outer.job', enabled: true },
  },
  templates: { outer: { version: 1, definition: OUTER } },
  instances: { outer: { template: 'outer', version: 1 } },
  inputs: { job: { to: 'outer.job', protocol: 'data' } },
  outputs: { result: { from: 'gate.passed', protocol: 'data' } },
  acceptance: [{ id: 'works', description: 'The nested work ran', kind: 'review', node: 'outer/inner/review' }],
};

const PROPOSAL = {
  requirementVersion: 1,
  summary: 'Nested rework layout',
  acceptance: [{ id: 'works', description: 'The nested work ran', checkNode: 'outer/inner/review' }],
  definition: DEFINITION,
};

/**
 * A provider that proposes the graph and then changes it: it adds a node and,
 * when the plan says so, takes it away again.
 */
async function nestedProvider(plan: 'add' | 'add-then-remove') {
  const requests: { body: { messages?: { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }[] } }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: { function?: { name?: string } }[];
      messages?: { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }[];
    } : {};
    requests.push({ body });
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph');
    const history = body.messages ?? [];
    const calls = history.flatMap(message => message.tool_calls ?? []).map(call => call.function?.name);
    const patches = calls.filter(name => name === 'graph_patch').length;
    const graphId = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(history))?.[1] ?? '';
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const toolCall = (id: string, name: string, args: unknown) => frame({
      id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
    });
    const stop = frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (master && calls.length === 0) {
      response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (master && graphId && patches === 0) {
      response.write(toolCall('call-add', 'graph_patch', {
        graphId, baseRevision: 1,
        changes: { reason: 'Add a downstream agent without moving the existing graph',
          patch: { nodes: { extra: worker }, edges: { extra: { from: 'gate.passed', to: 'extra.job', enabled: true } } } },
      }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (master && graphId && patches === 1 && plan === 'add-then-remove') {
      response.write(toolCall('call-remove', 'graph_patch', {
        graphId, baseRevision: 2,
        changes: { reason: 'Remove the idle extra node without repacking its siblings',
          retire: ['extra'], patch: { nodes: { extra: null }, edges: { extra: null } } },
      }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** The daemon, the proposal and the confirmed graph of one nested run. */
async function nestedFixture(plan: 'add' | 'add-then-remove') {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-nested-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Nested project\n');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await nestedProvider(plan);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_NESTED_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-nested', grade: 'high',
      api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_NESTED_KEY: 'synthetic-nested-key' }, extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, method = 'GET', data?: unknown) => {
    const response = await daemon.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  const created = await request('/api/conversations', 'POST', {
    projectId: 'p', model: 'local', text: 'Draw me a nested graph.', requestId: 'nested-1',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  let draft: { version?: number; draftRevision?: number; targetBranch?: string } = {};
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const view = await request(`/api/conversations/${conversationId}`);
    const proposal = (view.body as { proposal?: { version?: number; draftRevision?: number; targetBranch?: string } }).proposal;
    draft = proposal ?? {};
    if (proposal) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!draft.version) {
    const toolResults = provider.requests.flatMap(entry => entry.body.messages ?? [])
      .filter(message => message.role === 'tool')
      .map(message => JSON.stringify(message.content).slice(0, 1500));
    expect(draft.version, `no proposal\ntool results:\n${toolResults.join('\n')}\ndaemon:\n${daemon.stderr}`).toBeTruthy();
  }

  const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
    proposalVersion: draft.version ?? 1, draftRevision: draft.draftRevision ?? 1,
    targetBranch: draft.targetBranch ?? 'main', requestId: 'nested-confirm',
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const taskId = (confirmed.body as { taskId: string }).taskId;
  expect(taskId).toBeTruthy();

  const graph = async () => {
    const view = await request(`/api/tasks/${taskId}/graph`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    return view.body as GraphView;
  };
  return { provider, daemon, request, taskId, graph };
}

/** The nodes the graph had before it was changed. */
const ORIGINAL = ['outer', 'outer/inner', 'outer/inner/work', 'outer/inner/review', 'gate'];

test('a graph that holds another graph draws the container and keeps the back edge inside it', async () => {
  const f = await nestedFixture('add');
  const view = await f.graph();

  // The container, the instance and the members are all drawn.
  expect(view.containers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'outer/inner', parent: 'outer' })]));
  expect(view.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'outer/inner/work', container: 'outer/inner' })]));
  for (const id of ORIGINAL) {
    expect(view.layout.positions[id], id).toBeDefined();
  }
  // The edge that returns the work reaches the member it belongs to.
  expect(view.layout.edges).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rework', source: 'gate', target: 'outer/inner/work' })]));
}, 240_000);

test('adding a node to a nested graph leaves the nodes that were there where they were', async () => {
  const f = await nestedFixture('add');
  const before = (await f.graph()).layout.positions;

  const deadline = Date.now() + 60_000;
  let expanded = await f.graph();
  while (Date.now() < deadline && expanded.layout.positions.extra === undefined) {
    await new Promise(resolve => setTimeout(resolve, 500));
    expanded = await f.graph();
  }
  if (expanded.layout.positions.extra === undefined) {
    const toolResults = f.provider.requests.flatMap(entry => entry.body.messages ?? [])
      .filter(message => message.role === 'tool')
      .map(message => JSON.stringify(message.content).slice(0, 800));
    expect(expanded.layout.positions.extra, `no extra node\ntool results:\n${toolResults.join('\n')}\ndaemon:\n${f.daemon.stderr}`).toBeDefined();
  }
  // The new node is drawn, and the graph around it did not move.
  expect(expanded.layout.positions.extra).toBeDefined();
  for (const id of ORIGINAL) {
    expect(expanded.layout.positions[id], id).toEqual(before[id]);
  }
}, 240_000);

test('taking the node away again leaves the nested graph where it was', async () => {
  const f = await nestedFixture('add-then-remove');
  const before = (await f.graph()).layout.positions;

  const deadline = Date.now() + 60_000;
  let reduced = await f.graph();
  while (Date.now() < deadline && reduced.layout.positions.extra !== undefined) {
    await new Promise(resolve => setTimeout(resolve, 500));
    reduced = await f.graph();
  }
  expect(reduced.layout.positions.extra).toBeUndefined();
  for (const id of ORIGINAL) {
    expect(reduced.layout.positions[id], id).toEqual(before[id]);
  }
}, 240_000);
