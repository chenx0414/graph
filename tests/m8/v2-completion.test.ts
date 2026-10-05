import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

/**
 * Issue #1 HB-292: a v2 task finishes.
 *
 * Completion was decided entirely by the old kernel: `readyToComplete` read
 * `loadGraph(...)` and the `evidence` table, and a v2 task has rows in neither, so it could
 * never be completed. A graph could run every node to success and the task would sit at
 * `running` forever - which is also why eleven test files failed with the same signature.
 *
 * Two halves were missing:
 *   1. `kernel_nodes.status` was only ever written as `idle` or `blocked`, so a node that
 *      had succeeded still read as idle in the view.
 *   2. `readyToComplete` had no v2 branch.
 *
 * Failure modes first (R24):
 *   C1  a node that submits reads `succeeded`, not `idle`
 *   C2  a v2 task whose nodes all succeed reaches phase `completed`
 *   C3  a task with a node still unfinished does NOT complete
 */

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
  const nodes = (view as unknown as { nodes: { id: string; status: string }[] }).nodes;
  await runtime.close();
  await rm(root, { recursive: true, force: true });
  return { phase: view.phase, statuses: Object.fromEntries(nodes.filter(n => n.id !== 'master').map(n => [n.id, n.status])) };
}

test('C1: a v2 node that submits reads succeeded', async () => {
  const { statuses } = await run(1);
  expect(statuses).toEqual({ work: 'succeeded' });
}, 30_000);

test('C2: a v2 task whose nodes all succeeded reaches completed', async () => {
  // No Git is configured here, so there is no integration branch and no merge to wait for.
  // This pins the completion DECISION for a v2 graph, which is what was missing.
  const { phase } = await run(1);
  expect(phase).toBe('completed');
}, 30_000);

test('C3: a task with an unfinished node does not complete', async () => {
  const { phase } = await run(2);
  expect(phase).not.toBe('completed');
}, 30_000);
