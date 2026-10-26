import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The geometry of the graph the console draws.
 *
 * A layout is not a picture: it is the set of boxes the console renders and
 * the routes it draws between them. The boxes share a grid, so a node never
 * lands between two pixels; the routes are orthogonal and start and end on
 * the boundary of the node they connect; no route crosses a node it does not
 * belong to; and the edges that share a source and a target still take
 * separate channels, so a graph with four edges between two nodes reads as
 * four edges and not as one.
 *
 * The layout of the Go backend is drawn by elkjs, which the daemon reaches
 * through node. The proof is therefore the real daemon, the real elkjs and
 * the real graph: the boxes and the routes are the ones the console gets.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Point { x: number; y: number }
interface Rect extends Point { width: number; height: number }
interface Geometry {
  nodes: { id: string; kind: string; action?: string }[];
  layout: { positions: Record<string, Rect>; edges: { id: string; source: string; target: string; points?: Point[] }[] };
}

const worker = {
  recipe: 'coder@1', model: 'local', task: 'Do the work.',
  inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
  submission: { required: ['result'] },
};

/**
 * A graph with the shapes the router has to survive: four edges between the
 * same two nodes, an edge that returns to the first node, and an edge that
 * hands the work on.
 */
const DEFINITION = {
  schemaVersion: 2,
  name: 'Geometry',
  protocols: { data: { type: 'object' } },
  nodes: { work: worker, review: worker, extra: worker },
  modules: {},
  edges: {
    first: { from: 'work.result', to: 'review.job', enabled: true },
    parallelOne: { from: 'work.result', to: 'review.job', enabled: true },
    parallelTwo: { from: 'work.result', to: 'review.job', enabled: true },
    parallelThree: { from: 'work.result', to: 'review.job', enabled: true },
    back: { from: 'review.result', to: 'work.job', enabled: true },
    forward: { from: 'review.result', to: 'extra.job', enabled: true },
  },
  inputs: { job: { to: 'work.job', protocol: 'data' } },
  outputs: { result: { from: 'extra.result', protocol: 'data' } },
  acceptance: [{ id: 'works', description: 'The nodes ran', kind: 'review', node: 'review' }],
};

const PROPOSAL = {
  requirementVersion: 1,
  summary: 'Geometry graph',
  acceptance: [{ id: 'works', description: 'The nodes ran', checkNode: 'review' }],
  definition: DEFINITION,
};

/** A provider that proposes the graph once and then only talks. */
async function geometryProvider() {
  const requests: { master: boolean; body: { messages?: { role?: string; content?: unknown }[] } }[] = [];
  let proposed = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: unknown }[] } : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph');
    requests.push({ master, body });
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (master && !proposed) {
      proposed = true;
      response.write(frame({
        id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-propose', type: 'function',
          function: { name: 'propose_graph', arguments: JSON.stringify({ proposal: PROPOSAL, requestId: 'propose' }) } }] }, finish_reason: null }],
      }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
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

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Does the segment touch the box? */
function segmentHitsRect(from: Point, to: Point, rect: Rect) {
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);
  return left < rect.x + rect.width && right > rect.x && top < rect.y + rect.height && bottom > rect.y;
}

/** Do the two segments run into each other? */
function segmentsCross(left: [Point, Point], right: [Point, Point]) {
  const leftVertical = left[0].x === left[1].x;
  const rightVertical = right[0].x === right[1].x;
  // A vertical and a horizontal segment can only meet at a point.
  if (leftVertical !== rightVertical) return false;
  if (leftVertical) {
    return left[0].x === right[0].x
      && Math.max(Math.min(left[0].y, left[1].y), Math.min(right[0].y, right[1].y))
        < Math.min(Math.max(left[0].y, left[1].y), Math.max(right[0].y, right[1].y));
  }
  return left[0].y === right[0].y
    && Math.max(Math.min(left[0].x, left[1].x), Math.min(right[0].x, right[1].x))
      < Math.min(Math.max(left[0].x, left[1].x), Math.max(right[0].x, right[1].x));
}

test('the graph the console draws keeps its boxes on the grid and its routes off the nodes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-layout-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Geometry project\n');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await geometryProvider();
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LAYOUT_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-layout', grade: 'high',
      api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_LAYOUT_KEY: 'synthetic-layout-key' }, extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, method = 'GET', data?: unknown) => {
    const response = await daemon.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  const created = await request('/api/conversations', 'POST', {
    projectId: 'p', model: 'local', text: 'Draw me a graph.', requestId: 'layout-1',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  let draft: { version?: number; draftRevision?: number; targetBranch?: string } = {};
  let view: unknown = {};
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await request(`/api/conversations/${conversationId}`);
    view = current.body;
    const proposal = (current.body as { proposal?: { version?: number; draftRevision?: number; targetBranch?: string } }).proposal;
    draft = proposal ?? {};
    if (proposal) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!draft.version) {
    const events = await request(`/api/conversations/${conversationId}/events?after=0&limit=200`);
    const lines = (Array.isArray(events.body) ? events.body : []).slice(-30)
      .map((event: { cursor?: number; type?: string; data?: unknown }) =>
        `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 400)}`);
    const messages = ((view as { messages?: unknown[] }).messages ?? []).slice(-8)
      .map(message => JSON.stringify(message).slice(0, 600));
    const toolResults = provider.requests.flatMap(entry => (entry.body.messages ?? []))
      .filter(message => message.role === 'tool')
      .map(message => JSON.stringify(message.content).slice(0, 1200));
    expect(draft.version, `no proposal\ntool results:\n${toolResults.join('\n')}\nview: ${JSON.stringify(view).slice(0, 1200)}\nmessages:\n${messages.join('\n')}\nevents:\n${lines.join('\n')}\ndaemon:\n${daemon.stderr}`).toBeTruthy();
  }

  const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
    proposalVersion: draft.version ?? 1, draftRevision: draft.draftRevision ?? 1,
    targetBranch: draft.targetBranch ?? 'main', requestId: 'layout-confirm',
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const taskId = (confirmed.body as { taskId: string }).taskId;
  expect(taskId).toBeTruthy();

  let geometry: Geometry | undefined;
  await expect.poll(async () => {
    const view = await request(`/api/tasks/${taskId}/graph`);
    if (view.status !== 200) return undefined;
    const body = view.body as Geometry;
    geometry = body;
    return Object.keys(body.layout?.positions ?? {}).length;
  }, { timeout: 60_000, interval: 500 }).toBeGreaterThan(0);

  const laid = geometry!;
  expect(laid.nodes.length).toBeGreaterThan(0);
  expectDrawable(laid);

  // The layout is a fact about the topology: two readers see the same one.
  const concurrent = await Promise.all([
    request(`/api/tasks/${taskId}/graph`),
    request(`/api/tasks/${taskId}/graph`),
  ]);
  for (const view of concurrent) {
    expect((view.body as Geometry).layout).toEqual(laid.layout);
  }

  // A relayout draws the graph again, and the drawing is still a drawing the
  // console can show.
  const relayout = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'relayout' });
  expect(relayout.status, JSON.stringify(relayout.body)).toBe(200);
  const redrawn = await request(`/api/tasks/${taskId}/graph`);
  expect(redrawn.status).toBe(200);
  expectDrawable(redrawn.body as Geometry);
}, 240_000);

/** The contract of a drawing: boxes on the grid, routes between them. */
function expectDrawable(laid: Geometry) {
  const { layout, nodes } = laid;
  // Every box is on the grid and is a box the console can draw.
  for (const node of nodes) {
    const position = layout.positions[node.id];
    expect(position, node.id).toBeDefined();
    for (const [key, value] of Object.entries(position!)) {
      expect(Math.abs(Number(value) % 16), `${node.id}.${key}`).toBe(0);
    }
    expect(position!.width).toBeGreaterThanOrEqual(160);
    expect(position!.width).toBeLessThanOrEqual(384);
    expect(position!.width % 32, `${node.id} width`).toBe(0);
    expect([64, 96], `${node.id} height`).toContain(position!.height);
  }

  // The routes are the ones the definition asks for.
  expect(new Set(layout.edges.map(edge => edge.id))).toEqual(new Set(Object.keys(DEFINITION.edges)));

  const boxes = nodes.map(node => ({ id: node.id, ...layout.positions[node.id]! }));
  for (let left = 0; left < boxes.length; left++) {
    for (let right = left + 1; right < boxes.length; right++) {
      expect(overlaps(boxes[left]!, boxes[right]!), `${boxes[left]!.id} overlaps ${boxes[right]!.id}`).toBe(false);
    }
  }

  const segments: { edge: string; source: string; target: string; index: number; last: number; points: [Point, Point] }[] = [];
  for (const edge of layout.edges) {
    expect(edge.points?.length, `${edge.id} route`).toBeGreaterThanOrEqual(2);
    for (const point of edge.points!) {
      expect(Math.abs(point.x % 16), `${edge.id} x`).toBe(0);
      expect(Math.abs(point.y % 16), `${edge.id} y`).toBe(0);
    }
    const source = layout.positions[edge.source]!;
    const target = layout.positions[edge.target]!;
    // The route starts on the boundary of the source and ends on the boundary
    // of the target: a connector that starts in the middle of a node is not a
    // connector.
    expect(edge.points![0], `${edge.id} start`).toEqual({ x: source.x + source.width / 2, y: source.y + source.height });
    expect(edge.points!.at(-1), `${edge.id} end`).toEqual({ x: target.x + target.width / 2, y: target.y });
    for (let index = 0; index < edge.points!.length - 1; index++) {
      const segment: [Point, Point] = [edge.points![index]!, edge.points![index + 1]!];
      expect(segment[0].x === segment[1].x || segment[0].y === segment[1].y, `${edge.id} diagonal`).toBe(true);
      segments.push({ edge: edge.id, source: edge.source, target: edge.target, index, last: edge.points!.length - 2, points: segment });
      for (const box of boxes) {
        expect(segmentHitsRect(segment[0], segment[1], box), `${edge.id} crosses ${box.id}`).toBe(false);
      }
    }
  }

  // Two routes of different edges do not run into each other, except where they
  // share the stem they leave from or the stem they arrive at.
  for (let left = 0; left < segments.length; left++) {
    for (let right = left + 1; right < segments.length; right++) {
      const a = segments[left]!; const b = segments[right]!;
      if (a.edge === b.edge) continue;
      if (a.source === b.source && a.index === 0 && b.index === 0) continue;
      if (a.target === b.target && a.index === a.last && b.index === b.last) continue;
      expect(segmentsCross(a.points, b.points), `${a.edge} ${JSON.stringify(a.points)} overlaps ${b.edge} ${JSON.stringify(b.points)}`).toBe(false);
    }
  }

  // The four edges between the same two nodes take four separate channels:
  // one route would hide three of them.
  const parallel = layout.edges.filter(edge => edge.source === 'work' && edge.target === 'review');
  expect(parallel).toHaveLength(4);
  expect(new Set(parallel.map(edge => JSON.stringify(edge.points))).size).toBe(4);
}
