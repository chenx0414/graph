import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

/** Native public lifecycle: successful node status, explicit completion and confirmed evidence stay distinct. */

const definition = {
  schemaVersion: 2, name: 'finishes',
  protocols: { out: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  nodes: {
    work: { recipe: 'worker@1', task: 'work', acceptance: ['ok'], inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } },
  },
  modules: {}, edges: {}, inputs: {}, outputs: {},
};

async function run(limitNodes = 1) {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-complete-'));
  await mkdir(join(root, 'state'), { recursive: true });
  const work: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async () => async () => ({ outcome: 'completed', output: { text: 'done' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
  };
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }], actions: { work },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'go', requestId: 'b' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'finish',
    acceptance: [{ id: 'ok', description: 'ran', checkNode: 'work' }],
    nodes: [],
    definition: limitNodes === 1 ? definition : {
      ...definition,
      nodes: { ...definition.nodes, other: { recipe: 'worker@1', task: 'other', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } } },
    },
  } as never, 'draft');
  // No Git is configured, so there is no integration branch and no delivery to wait for:
  // this run is about the completion decision itself, not about merging into a branch.
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'a' });
  for (let i = 0; i < 5; i += 1) await runtime.host.drive();
  const idle = await runtime.user.task(taskId).view();
  expect(idle.phase).not.toBe('completed');
  await runtime.controlGraph(taskId, { action: 'complete' });
  await runtime.host.drive();
  const view = await runtime.user.task(taskId).view();
  const acceptance = await runtime.supervisor(taskId).graphInspect({ graphId: taskId, query: 'acceptance' }) as { items: { id: string; status: string }[] };
  const nodes = (view as unknown as { nodes: { id: string; status: string }[] }).nodes;
  await runtime.close();
  await rm(root, { recursive: true, force: true });
  return { phase: view.phase, acceptance, statuses: Object.fromEntries(nodes.filter(n => n.id !== 'master').map(n => [n.id, n.status])) };
}

test('C1: a v2 node that submits reads succeeded', async () => {
  const { statuses } = await run(1);
  expect(statuses).toEqual({ work: 'succeeded' });
}, 30_000);

test('C2: successful node status cannot replace confirmed final evidence', async () => {
  const { phase, statuses, acceptance } = await run(1);
  expect(statuses).toEqual({ work: 'succeeded' });
  expect(phase).toBe('blocked');
  expect(acceptance.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ok', status: 'missing' })]));
}, 30_000);

test('C3: a node that cannot supply its required output stays visible as failed', async () => {
  const { statuses } = await run(2);
  expect(statuses.other).toBe('failed');
}, 30_000);
