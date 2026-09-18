import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { graphNodeSize } from '../../src/core/graph-presentation.ts';
import { createApp } from '../../src/server/app.ts';
import { layoutGraph } from '../../src/server/layout.ts';
import * as templates from '../../src/core/templates.ts';
import type { ActionAdapter, Json, Proposal } from '../../src/core/types.ts';
import type { VerifierConfig } from '../../src/core/verification.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
const origin = 'http://127.0.0.1:1';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
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

async function graphOf(create: (root: string) => { actions: Record<string, ActionAdapter>; graph: Pick<Proposal, 'nodes' | 'containers' | 'loops'>; acceptance?: Proposal['acceptance'] }) {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-graph-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixture = create(root);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: fixture.actions });
  cleanup.push(() => runtime.close());
  const app = await createApp(runtime, { origin });
  cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } });
  const headers = { origin, cookie: String(home.headers['set-cookie'] ?? ''), 'content-type': 'application/json' };
  const begun = JSON.parse((await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: JSON.stringify({ projectId: 'project', request: 'Graph', requestId: 'begin' }) })).body);
  await runtime.supervisor(begun.taskId).propose({
    requirementVersion: 1, summary: 'Graph',
    acceptance: fixture.acceptance ?? [{ id: 'works', description: 'Works', checkNode: fixture.graph.nodes.find(node => node.kind === 'program' && node.action !== 'route' && node.action !== 'join')?.id ?? 'check' }],
    ...fixture.graph,
  }, 'proposal');
  await app.inject({ method: 'POST', url: `/api/tasks/${begun.taskId}/accept`, headers, payload: JSON.stringify({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' }) });
  await runtime.host.drive();
  const graph = JSON.parse((await app.inject({ method: 'GET', url: `/api/tasks/${begun.taskId}/graph`, headers })).body);
  const operations = JSON.parse((await app.inject({ method: 'GET', url: `/api/tasks/${begun.taskId}/operations?limit=2`, headers })).body) as unknown[];
  return { graph, operations, view: JSON.parse((await app.inject({ method: 'GET', url: `/api/tasks/${begun.taskId}`, headers })).body) };
}

const agent = (output: Json): ActionAdapter => ({ kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output, usage }) });
const check = (root: string, name: string): ActionAdapter => ({ kind: 'program', prepare: async () => async () => {
  const path = join(root, `${name}.txt`); await writeFile(path, 'ok');
  return { outcome: 'completed', output: { passed: true }, evidence: [{ acceptanceId: 'works', summary: 'Checked', artifact: { path, digest: digest('ok') } }] };
} });

test('HTTP graph payloads include layout, containers and back-edges for the shared templates', async () => {
  const pipeline = await graphOf(root => ({ actions: { implement: agent({ done: true }), check: check(root, 'p') }, graph: templates.pipeline() }));
  expect(pipeline.graph.layout.positions.implement).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  expect(pipeline.graph.layout.edges.some((edge: { source: string; target: string }) => edge.source === 'implement' && edge.target === 'check')).toBe(true);
  const routed = await graphOf(root => ({ actions: {
    route: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: { selected: 'text' }, route: 'text' }) },
    text: agent({ format: 'text' }), json: agent({ format: 'json' }),
    join: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: { selected: 'text' } }) },
    check: check(root, 'r'),
  }, graph: templates.router() }));
  expect(routed.graph.containers.some((container: { id: string }) => container.id === 'inner')).toBe(true);
  expect(routed.graph.layout.positions.outer).toBeDefined();
  const looped = await graphOf(root => ({
    actions: {
      implement: agent({ version: 1 }),
      review: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { schemaVersion: 1, subject: { id: 'a', path: join(root, 'a.txt'), digest: digest('a') }, body: { kind: 'multiview', dimensions: { correctness: { verdict: 'pass', reason: 'ok', evidence: [] } } } }, usage }) },
    },
    graph: templates.evaluateOptimize({ kind: 'multiview', subjectNode: 'implement', reportNodes: ['review'], dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] }),
    acceptance: [{ id: 'works', description: 'Optimized', checkNode: 'gate' }],
  }));
  expect(looped.graph.loops).toEqual([{ from: 'gate', to: 'implement' }]);
  expect(looped.graph.layout.edges.some((edge: { id: string }) => edge.id.startsWith('loop:'))).toBe(true);
  expect(looped.operations.length).toBeLessThanOrEqual(2);
});

test('every template including back-edges receives layout positions', async () => {
  const optimize: Extract<VerifierConfig, { kind: 'multiview' }> = { kind: 'multiview', subjectNode: 'implement', reportNodes: ['review'], dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const critic: Extract<VerifierConfig, { kind: 'adversarial' }> = { kind: 'adversarial', subjectNode: 'implement', reportNodes: ['critic'], acceptanceCriteria: ['works'] };
  const ranking = [{ id: 'quality', weight: 1, min: 0, max: 10 }];
  const select: Extract<VerifierConfig, { kind: 'jury' }> = { kind: 'jury', reportNodes: ['jury'], hardCriteria: ['compiles'], ranking, tieOrder: ['quality'], candidates: [{ id: 'a', node: 'candidate-a' }, { id: 'b', node: 'candidate-b' }] };
  const graphs = [
    templates.pipeline(), templates.fanout(), templates.router(), templates.supervisorWorkers(2),
    templates.evaluateOptimize(optimize), templates.adversarial(critic), templates.multiview(optimize),
    templates.jury({ select, final: { ...select, reportNodes: ['final-review'], candidates: [{ id: 'absorbed', node: 'absorb' }], revalidate: { selectionNode: 'select', subjectNode: 'absorb' } } }),
  ];
  for (const graph of graphs) {
    const layout = await layoutGraph(graph);
    for (const node of graph.nodes) {
      const position = layout.positions[node.id];
      expect(position, node.id).toBeDefined();
      if (!position) continue;
      expect(Math.abs(position.x % 16), `${node.id} x`).toBe(0);
      expect(Math.abs(position.y % 16), `${node.id} y`).toBe(0);
      expect(position).toMatchObject(graphNodeSize(node));
    }
    for (const loop of graph.loops ?? []) expect(layout.edges.some(edge => edge.source === loop.from && edge.target === loop.to)).toBe(true);
  }
});

test('orthogonal dependency routes avoid node overlap and edge crossings', async () => {
  const optimize: Extract<VerifierConfig, { kind: 'multiview' }> = { kind: 'multiview', subjectNode: 'implement', reportNodes: ['review'], dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const ranking = [{ id: 'quality', weight: 1, min: 0, max: 10 }];
  const select: Extract<VerifierConfig, { kind: 'jury' }> = { kind: 'jury', reportNodes: ['jury'], hardCriteria: ['compiles'], ranking, tieOrder: ['quality'], candidates: [{ id: 'a', node: 'candidate-a' }, { id: 'b', node: 'candidate-b' }] };
  const graphs = [
    templates.fanout(),
    templates.router(),
    templates.supervisorWorkers(3),
    templates.evaluateOptimize(optimize),
    templates.jury({ select, final: { ...select, reportNodes: ['final-review'], candidates: [{ id: 'absorbed', node: 'absorb' }], revalidate: { selectionNode: 'select', subjectNode: 'absorb' } } }),
  ];
  for (const graph of graphs) {
    const layout = await layoutGraph(graph);
    const nodes = graph.nodes.map(node => ({ id: node.id, ...layout.positions[node.id]! }));
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        expect(overlaps(nodes[left]!, nodes[right]!), `${nodes[left]!.id} overlaps ${nodes[right]!.id}`).toBe(false);
      }
    }
    const segments: { edge: string; points: [{ x: number; y: number }, { x: number; y: number }] }[] = [];
    for (const edge of layout.edges.filter(edge => !edge.id.startsWith('loop:'))) {
      expect(edge.points?.length, `${edge.id} route`).toBeGreaterThanOrEqual(2);
      const source = nodes.find(node => node.id === edge.source);
      const target = nodes.find(node => node.id === edge.target);
      if (source) expect(onNodeBoundary(edge.points![0]!, source), `${edge.id} starts on ${source.id}`).toBe(true);
      if (target) expect(onNodeBoundary(edge.points!.at(-1)!, target), `${edge.id} ends on ${target.id}`).toBe(true);
      for (let index = 0; index < (edge.points?.length ?? 0) - 1; index += 1) {
        const segment = [edge.points![index]!, edge.points![index + 1]!] as [{ x: number; y: number }, { x: number; y: number }];
        segments.push({ edge: edge.id, points: segment });
        for (const node of nodes) {
          if (node.id === edge.source || node.id === edge.target) continue;
          expect(segmentHitsRect(segment[0], segment[1], node), `${edge.id} crosses ${node.id}`).toBe(false);
        }
      }
    }
    for (let left = 0; left < segments.length; left += 1) {
      for (let right = left + 1; right < segments.length; right += 1) {
        if (segments[left]!.edge === segments[right]!.edge) continue;
        expect(
          segmentsCross(segments[left]!.points, segments[right]!.points),
          `${segments[left]!.edge} crosses ${segments[right]!.edge}`,
        ).toBe(false);
      }
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
