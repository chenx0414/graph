import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

/**
 * Issue #1 HB-287: a parked v2 node is visible in the task view.
 *
 * HB-285 parks a node whose budget is exhausted and records `graph.node.blocked`, but the
 * task view read only the old `nodes` table. A v2 task therefore showed no graph at all,
 * and a node stopped on an exhausted budget was indistinguishable from one that had never
 * been scheduled. Failure that cannot be seen is failure nobody acts on (HB-272).
 *
 * Failure modes first (R24):
 *   V1  a confirmed v2 task's view lists the graph's nodes
 *   V2  a node parked on budget reads as blocked, not as idle or missing
 *   V3  the master node is still listed - the v2 rows are merged, not substituted
 */

test('V1/V2/V3: a v2 task view lists its graph, and a parked node reads blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-view-'));
  await mkdir(join(root, 'state'), { recursive: true });
  const work: ActionAdapter = { kind: 'agent', reserveTokens: 1_000_000, prepare: async () => async () => ({ outcome: 'completed', output: { text: 'x' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }) };
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root }],
    actions: { work },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    // A budget the turn cannot possibly fit in, so the node is parked.
    limits: { defaultBudgetTokens: 10 },
  } as never);
  try {
    const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'go', requestId: 'b' });
    const proposed = await runtime.supervisor(taskId).propose({
      requirementVersion: 1, summary: 'one node',
      acceptance: [{ id: 'ok', description: 'ran', checkNode: 'work' }],
      nodes: [],
      definition: {
        schemaVersion: 2, name: 'one',
        protocols: { out: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
        nodes: { work: { recipe: 'worker@1', task: 'work', inputs: { job: { protocol: 'out' } }, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } } },
        modules: {}, edges: {}, inputs: {}, outputs: {},
      },
    } as never, 'draft');
    await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'a' });
    await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: { text: 'go' } });
    for (let i = 0; i < 3; i += 1) await runtime.host.pump();

    const view = await runtime.user.task(taskId).view();
    const nodes = (view as unknown as { nodes: { id: string; status: string; origin?: string }[] }).nodes;
    expect(nodes.map(n => n.id).sort()).toEqual(['master', 'work']);
    expect(nodes.find(n => n.id === 'work')).toMatchObject({ status: 'blocked', origin: 'v2' });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
