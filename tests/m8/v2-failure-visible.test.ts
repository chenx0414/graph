import { expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeExecutor } from '../../src/core/node-executor.ts';
import { TaskStore } from '../../src/core/store.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 HB-295: a failed v2 node says so.
 *
 * Chasing one silent failure took several probes, because the failure left nothing to read:
 * the queue row said `failed` with no reason, the node's own status stayed `idle`, and no
 * event was written. HB-272 requires that a graph that cannot run be visible; on the v2 path
 * it was not.
 *
 * Failure modes first (R24):
 *   F1  a failed node reads `failed`, not `idle` - the graph shows what actually happened
 *   F2  a `graph.node.failed` event carries the reason
 *   F3  the queued row keeps the reason, so it survives a restart
 *   F4  a blocked node is still reported as blocked, not failed - they are different facts
 */

const definition = {
  schemaVersion: 2, name: 'fails',
  protocols: { out: { type: 'object', properties: { v: { type: 'string' } } } },
  nodes: { a: { recipe: 'worker@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } } },
  modules: {}, edges: {}, inputs: {}, outputs: {},
} as unknown as GraphDefinition;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-failvis-'));
  await mkdir(join(root, 'state'), { recursive: true });
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  store.db.prepare("INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','{}')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('t1','p1','work','running',1)").run();
  const kernel = new KernelStore(store);
  kernel.insertRevision('t1', definition, 'fails', 1);
  kernel.admitNode('t1', 1, 'a', { instanceId: 'inst-a' });
  kernel.enqueue('t1', { nodeId: 'a', kind: 'start', payload: {} as never });
  return { root, store, kernel };
}

const host = { start: async () => ({ processId: 1 }), alive: () => true, turn: async () => ({ turnId: 't', inspect: {} }) };

test('F1/F2/F3: a failed node is marked failed, records the reason, and emits an event', async () => {
  const { root, store, kernel } = await setup();
  try {
    const executor = new NodeExecutor({ kernel, graphId: 't1', host });
    // A turn that submits nothing: the executor exhausts its attempts and fails.
    await executor.runNode('a', async () => ({ missing: ['out'], usage: { total: 1 } }));

    expect(kernel.nodeStatus('t1', 'a')).toBe('failed');
    const row = store.db.prepare("SELECT reason FROM kernel_queue WHERE task_id='t1'").get() as { reason: string | null };
    expect(row.reason).toMatch(/submission|missing/i);
    const event = store.db.prepare("SELECT type,data FROM events WHERE task_id='t1' AND type='graph.node.failed'").get() as { type: string; data: string } | undefined;
    expect(event).toBeTruthy();
    expect(JSON.parse(event!.data)).toMatchObject({ nodeId: 'a' });
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('F4: a blocked node is reported as blocked, which is a different fact', async () => {
  const { root, store, kernel } = await setup();
  try {
    // Two different outcomes, and the view must not conflate them.
    const budgeted = new NodeExecutor({ kernel, graphId: 't1', host, tokenBudget: { budget: 1, unlimited: false }, reserveTokens: 1000 });
    const blocked = await budgeted.runNode('a', async () => ({ missing: ['out'], usage: { total: 1 } }));
    expect(blocked).toBe('blocked');
    expect(kernel.nodeStatus('t1', 'a')).toBe('blocked');
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id='t1' AND type='graph.node.blocked'").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id='t1' AND type='graph.node.failed'").get()).toEqual({ n: 0 });
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
