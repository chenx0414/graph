import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { graphNodeSize } from '../../src/core/graph-presentation.ts';
import { createApp } from '../../src/server/app.ts';
import { parseGraphDefinition, type GraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { nativeReviewPattern } from '../fixtures/native-patterns.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const origin = 'http://127.0.0.1:1';
const overlaps = (
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) => left.x < right.x + right.width
  && left.x + left.width > right.x
  && left.y < right.y + right.height
  && left.y + left.height > right.y;

function segmentHitsRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
) {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  return left < rect.x + rect.width
    && right > rect.x
    && top < rect.y + rect.height
    && bottom > rect.y;
}

function segmentsCross(
  left: [{ x: number; y: number }, { x: number; y: number }],
  right: [{ x: number; y: number }, { x: number; y: number }],
) {
  const leftVertical = left[0].x === left[1].x;
  const rightVertical = right[0].x === right[1].x;
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

function onNodeBoundary(point: { x: number; y: number }, node: { x: number; y: number; width: number; height: number }) {
  const onHorizontal = point.y === node.y || point.y === node.y + node.height;
  const onVertical = point.x === node.x || point.x === node.x + node.width;
  return (onHorizontal && point.x >= node.x && point.x <= node.x + node.width)
    || (onVertical && point.y >= node.y && point.y <= node.y + node.height);
}

test('native HTTP graphs retain nested parents, mapped back-edges and stable positions as real deliveries arrive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-http-layout-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const projectAlias = join(root, 'project-link'); await symlink(project, projectAlias);
  const value = { passed: true, subject: 'stable-result' };
  const submit = { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value } } }) }] };
  const provider = await openaiServer([submit, { text: 'Produced' }, submit, { text: 'Reviewed' }]); cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: projectAlias }], models: { apiKey: 'local-only', modelRuntime: provider.runtime,
    entries: [{ id: 'worker', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] } });
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const app = await createApp(runtime, { origin }); cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } });
  const headers = { origin, cookie: String(home.headers['set-cookie'] ?? '') };
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Native layout', requestId: 'begin' }); const main = runtime.supervisor(taskId);
  const endpoint = { protocol: 'data' };
  const worker = { recipe: 'coder@1', model: 'worker', task: 'Submit the delivered work', inputs: { job: endpoint }, outputs: { result: endpoint }, submission: { required: ['result'] } };
  const inner = parseGraphDefinition({ schemaVersion: 2, name: 'Inner', protocols: { data: { type: 'object' } }, nodes: { work: worker, review: worker }, modules: {},
    edges: { review: { from: 'work.result', to: 'review.job', enabled: true } }, inputs: { job: { to: 'work.job', protocol: 'data' } }, outputs: { result: { from: 'review.result', protocol: 'data' } } });
  const outer = parseGraphDefinition({ schemaVersion: 2, name: 'Outer', protocols: { data: { type: 'object' } }, nodes: {}, modules: {}, edges: {},
    templates: { inner: { version: 1, definition: inner } }, instances: { inner: { template: 'inner', version: 1 } },
    inputs: { job: { to: 'inner.job', protocol: 'data' } }, outputs: { result: { from: 'inner.result', protocol: 'data' } } });
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Nested rework layout', protocols: { data: { type: 'object' } }, nodes: {},
    templates: { outer: { version: 1, definition: outer } }, instances: { outer: { template: 'outer', version: 1 } },
    modules: { gate: { type: 'router', trigger: 'each', inputs: { review: endpoint }, outputs: { rework: endpoint, passed: endpoint },
      rules: [{ when: 'review.passed == false', emit: { rework: '$review' } }, { when: 'review.passed == true', emit: { passed: '$review' } }] } },
    edges: { judgment: { from: 'outer.result', to: 'gate.review', enabled: true }, rework: { from: 'gate.rework', to: 'outer.job', enabled: true } },
    inputs: { job: { to: 'outer.job', protocol: 'data' } }, outputs: { result: { from: 'gate.passed', protocol: 'data' } } });
  const { graphId } = await main.graphCreate({ definition }) as { graphId: string };
  const graph = async () => {
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${graphId}/graph`, headers }); expect(response.statusCode, response.body).toBe(200);
    return JSON.parse(response.body);
  };
  const before = await graph();
  expect(before.containers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'outer/inner', parent: 'outer' })]));
  expect(before.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'outer/inner/work', container: 'outer/inner' })]));
  expect(before.layout.positions.outer).toBeDefined(); expect(before.layout.positions['outer/inner']).toBeDefined();
  expect(before.layout.edges).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rework', source: 'gate', target: 'outer/inner/work' })]));
  await main.graphSend({ graphId, input: 'job', value: {} }); await runtime.host.drive();
  expect(provider.requests, JSON.stringify(await main.graphInspect({ graphId, query: 'queue' }))).toHaveLength(4);
  const after = await graph(); expect(after.layout).toEqual(before.layout);
  expect(after.interfaces).toEqual(expect.arrayContaining([expect.objectContaining({ edgeId: 'judgment', latest: value }), expect.objectContaining({ edgeId: 'rework', latest: null, deliveries: [] })]));
  expect(after.modules).toEqual(expect.arrayContaining([expect.objectContaining({ moduleId: 'gate', inputs: [expect.objectContaining({ name: 'review', value })], transitions: [] })]));
  const judgments = await app.inject({ method: 'GET', url: `/api/tasks/${graphId}/graph/modules/gate?limit=20`, headers });
  expect(judgments.statusCode).toBe(200);
  expect(JSON.parse(judgments.body)).toMatchObject({ inputs: [expect.objectContaining({ name: 'review', value })], transitions: [expect.objectContaining({ outputs: { passed: value } })] });
  const operations = await app.inject({ method: 'GET', url: `/api/tasks/${graphId}/operations?limit=2`, headers });
  expect(operations.statusCode).toBe(200); expect(JSON.parse(operations.body).length).toBeLessThanOrEqual(2);
  await main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Add a downstream agent without moving the existing graph',
    patch: { nodes: { extra: worker }, edges: { extra: { from: 'gate.passed', to: 'extra.job', enabled: true } } } } });
  const expanded = await graph();
  for (const id of ['outer', 'outer/inner', 'outer/inner/work', 'outer/inner/review', 'gate']) {
    expect(expanded.layout.positions[id], id).toEqual(after.layout.positions[id]);
  }
  expect(expanded.layout.positions.extra).toBeDefined();
  const concurrent = await Promise.all([graph(), graph(), graph()]);
  for (const snapshot of concurrent) expect(snapshot.layout).toEqual(expanded.layout);
  await main.graphControl({ graphId, action: 'relayout' });
  const rearranged = await graph();
  expect(rearranged.layout).not.toEqual(expanded.layout);
  await main.graphPatch({ graphId, baseRevision: 2, changes: { reason: 'Remove the idle extra node without repacking its siblings', retire: ['extra'],
    patch: { nodes: { extra: null }, edges: { extra: null } } } });
  const reduced = await graph();
  for (const id of ['outer', 'outer/inner', 'outer/inner/work', 'outer/inner/review', 'gate']) {
    expect(reduced.layout.positions[id], id).toEqual(rearranged.layout.positions[id]);
  }
  expect(reduced.layout.positions.extra).toBeUndefined();
  await main.graphPatch({ graphId, baseRevision: 3, changes: { reason: 'Grow the inner subgraph around a new member',
    patch: { nodes: { 'outer/inner/extra': worker }, edges: { nestedExtra: { from: 'outer/inner/review.result', to: 'outer/inner/extra.job', enabled: true } } } } });
  const nested = await graph();
  for (const id of ['outer/inner/work', 'outer/inner/review']) expect(nested.layout.positions[id], id).toEqual(reduced.layout.positions[id]);
  for (const id of ['outer', 'outer/inner']) {
    expect(nested.layout.positions[id]).toMatchObject({ x: reduced.layout.positions[id].x, y: reduced.layout.positions[id].y });
  }
  const member = nested.layout.positions['outer/inner/extra']; const parent = nested.layout.positions['outer/inner'];
  expect(member.x).toBeGreaterThanOrEqual(parent.x); expect(member.y).toBeGreaterThanOrEqual(parent.y);
  expect(member.x + member.width).toBeLessThanOrEqual(parent.x + parent.width);
  expect(member.y + member.height).toBeLessThanOrEqual(parent.y + parent.height);
  const leaves = nested.nodes.map((node: { id: string }) => ({ id: node.id, ...nested.layout.positions[node.id] }));
  for (let left = 0; left < leaves.length; left++) for (let right = left + 1; right < leaves.length; right++) {
    expect(overlaps(leaves[left]!, leaves[right]!), `${leaves[left]!.id}/${leaves[right]!.id}`).toBe(false);
  }
  for (const edge of nested.layout.edges) {
    expect(edge.points.length).toBeGreaterThanOrEqual(2);
    for (let n = 0; n < edge.points.length - 1; n++) for (const leaf of leaves) {
      expect(segmentHitsRect(edge.points[n], edge.points[n + 1], leaf), `${edge.id}/${leaf.id}`).toBe(false);
    }
  }
  await runtime.close();
  const recovered = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: projectAlias }] }); cleanup.push(() => recovered.close());
  const recoveredApp = await createApp(recovered, { origin }); cleanup.push(() => recoveredApp.close());
  const recoveredHome = await recoveredApp.inject({ method: 'GET', url: '/', headers: { origin } });
  const recoveredGraph = await recoveredApp.inject({ method: 'GET', url: `/api/tasks/${graphId}/graph`,
    headers: { origin, cookie: String(recoveredHome.headers['set-cookie'] ?? '') } });
  expect(recoveredGraph.statusCode).toBe(200);
  expect(JSON.parse(recoveredGraph.body).layout).toEqual(nested.layout);

});

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Geometry = { nodes: { id: string; kind: string; action: string }[]; layout: { positions: Record<string, Rect>; edges: { id: string; source: string; target: string; points?: Point[] }[] } };

async function* nativeGeometries() {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-geometries-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }] }); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder'); runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const app = await createApp(runtime, { origin }); cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } }); const headers = { origin, cookie: String(home.headers['set-cookie'] ?? '') };
  const { taskId: ownerId } = await runtime.user.begin({ projectId: 'p', request: 'Native geometry', requestId: 'begin' }); const main = runtime.supervisor(ownerId);
  for (const name of ['pipeline', 'fanout', 'router', 'supervisor-workers', 'optimize', 'adversarial', 'multiview', 'jury', 'parallel-and-self']) {
    let definition: GraphDefinition;
    if (['pipeline', 'fanout', 'router', 'supervisor-workers'].includes(name)) definition = parseGraphDefinition(JSON.parse(await readFile(join(process.cwd(), 'examples/graphs', `${name}.json`), 'utf8')));
    else {
      const directory = join(root, name); await mkdir(directory);
      definition = await nativeReviewPattern(directory, name === 'parallel-and-self' ? 'optimize' : name as 'optimize' | 'adversarial' | 'multiview' | 'jury');
      if (name === 'parallel-and-self') {
        for (let index = 0; index < 6; index++) definition.edges[`parallel-${index}`] = { ...definition.edges['edge-0']! };
        definition.edges.self = { from: 'review.result', to: 'review.job', enabled: true };
      }
    }
    const { graphId } = await main.graphCreate({ definition }) as { graphId: string };
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${graphId}/graph`, headers }); expect(response.statusCode, `${name}: ${response.body}`).toBe(200);
    yield { name, definition, geometry: JSON.parse(response.body) as Geometry };
  }
}

test('native HTTP positions, sizes, connectors and every back-edge share the grid', async () => {
  for await (const { name, definition, geometry } of nativeGeometries()) {
    const { layout, nodes } = geometry;
    for (const node of nodes) {
      const position = layout.positions[node.id]; expect(position, `${name}/${node.id}`).toBeDefined();
      for (const value of Object.values(position!)) expect(Math.abs(value % 16), `${name}/${node.id} box grid`).toBe(0);
      expect(position).toMatchObject(graphNodeSize(node));
    }
    expect(new Set(layout.edges.map(edge => edge.id)), name).toEqual(new Set(Object.keys(definition.edges)));
    for (const edge of layout.edges) {
      expect(edge.points?.length, `${name}/${edge.id} route`).toBeGreaterThanOrEqual(2);
      for (const point of edge.points!) { expect(Math.abs(point.x % 16), `${name}/${edge.id} x`).toBe(0); expect(Math.abs(point.y % 16), `${name}/${edge.id} y`).toBe(0); }
      const source = layout.positions[edge.source]!; const target = layout.positions[edge.target]!;
      expect(edge.points![0]).toEqual({ x: source.x + source.width / 2, y: source.y + source.height });
      expect(edge.points!.at(-1)).toEqual({ x: target.x + target.width / 2, y: target.y });
    }
  }
});

test('native HTTP orthogonal routes avoid nodes and give parallel and feedback edges distinct channels', async () => {
  for await (const { name, geometry } of nativeGeometries()) {
    const { layout } = geometry; const nodes = geometry.nodes.map(node => ({ id: node.id, ...layout.positions[node.id]! }));
    for (let left = 0; left < nodes.length; left++) for (let right = left + 1; right < nodes.length; right++) expect(overlaps(nodes[left]!, nodes[right]!), `${name}: ${nodes[left]!.id} overlaps ${nodes[right]!.id}`).toBe(false);
    const segments: { edge: typeof layout.edges[number]; index: number; points: [Point, Point] }[] = [];
    for (const edge of layout.edges) {
      expect(edge.points?.length, `${name}/${edge.id} route`).toBeGreaterThanOrEqual(2);
      const source = nodes.find(node => node.id === edge.source)!; const target = nodes.find(node => node.id === edge.target)!;
      expect(onNodeBoundary(edge.points![0]!, source), `${edge.id} source boundary`).toBe(true); expect(onNodeBoundary(edge.points!.at(-1)!, target), `${edge.id} target boundary`).toBe(true);
      for (let index = 0; index < edge.points!.length - 1; index++) {
        const segment: [Point, Point] = [edge.points![index]!, edge.points![index + 1]!];
        expect(segment[0].x === segment[1].x || segment[0].y === segment[1].y, `${name}/${edge.id} diagonal`).toBe(true); segments.push({ edge, index, points: segment });
        for (const node of nodes) expect(segmentHitsRect(segment[0], segment[1], node), `${name}/${edge.id} crosses ${node.id}`).toBe(false);
      }
    }
    for (let left = 0; left < segments.length; left++) for (let right = left + 1; right < segments.length; right++) {
      const a = segments[left]!; const b = segments[right]!; if (a.edge.id === b.edge.id) continue;
      // The single visual connector necessarily shares its immediate stem; channels after that remain separate.
      if (a.edge.source === b.edge.source && a.index === 0 && b.index === 0) continue;
      if (a.edge.target === b.edge.target && a.index === a.edge.points!.length - 2 && b.index === b.edge.points!.length - 2) continue;
      expect(segmentsCross(a.points, b.points), `${name}/${a.edge.id} ${JSON.stringify(a.points)} overlaps ${b.edge.id} ${JSON.stringify(b.points)}`).toBe(false);
    }
    if (name === 'parallel-and-self') {
      const channels = layout.edges.filter(edge => edge.id === 'edge-0' || edge.id.startsWith('parallel-'));
      expect(new Set(channels.map(edge => JSON.stringify(edge.points))).size).toBe(7);
    }
  }
});

test('catalog lists published definitions and task views expose a cost field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-cost-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }] });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'pub');
  const app = await createApp(runtime, { origin });
  cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } });
  const headers = { origin, cookie: String(home.headers['set-cookie'] ?? '') };
  const catalog = JSON.parse((await app.inject({ method: 'GET', url: '/api/catalog', headers })).body);
  expect(catalog.definitions).toMatchObject([{ id: 'coder', version: 1 }]);
  const begun = JSON.parse((await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ projectId: 'project', request: 'Cost', requestId: 'begin' }) })).body);
  const view = JSON.parse((await app.inject({ method: 'GET', url: `/api/tasks/${begun.taskId}`, headers })).body);
  expect(view.cost).toEqual({ amount: 0 });
});
