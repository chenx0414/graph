import { expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { TaskStore } from '../../src/core/store.ts';

/**
 * Issue #1 HB-284: a v2 node needs a token budget of its own.
 *
 * The old executor meters through the `instances` table, and `instances` carries
 * `FOREIGN KEY(task_id,node_id) REFERENCES nodes(task_id,id)`. A v2 node has no row in
 * `nodes`, so it cannot have an `instances` row either — metering is structurally bound to
 * the old kernel, and a v2 node could spend without limit.
 *
 * The budget therefore lives on the kernel's own node state instead, keyed by the same
 * `instance_id` the node was admitted with.
 *
 * Failure modes first (R24):
 *   B1  a node starts with its declared budget and nothing used or reserved
 *   B2  a reservation is held while work is in flight and released when it settles
 *   B3  committed usage is counted once, and re-committing the same total is idempotent
 *   B4  a reservation beyond the budget is refused, and the node is left unreserved
 *   B5  an unlimited node is never refused
 */

const definition = {
  schemaVersion: 2 as const,
  name: 'metered',
  protocols: { out: { type: 'object' as const, required: ['v'], properties: { v: { type: 'string' } } } },
  nodes: {
    a: { recipe: 'worker@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } },
    b: { recipe: 'worker@1', task: 'b', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } },
  },
  modules: {}, edges: {}, inputs: {}, outputs: {},
};

const withRuntime = async (action: (store: TaskStore, kernel: KernelStore, taskId: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-budget-'));
  await mkdir(join(root, 'state'), { recursive: true });
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  try {
    store.db.prepare("INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','{}')").run();
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('t1','p1','work','running',1)").run();
    const kernel = new KernelStore(store);
    kernel.insertRevision('t1', definition as never, 'metered', 1);
    kernel.admitNode('t1', 1, 'a', { instanceId: 'inst-a' });
    kernel.admitNode('t1', 1, 'b', { instanceId: 'inst-b' });
    await action(store, kernel, 't1');
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
};

test('B1: an admitted node carries its declared budget, with nothing used or reserved', async () => {
  await withRuntime(async (_store, kernel) => {
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }))
      .toEqual({ budget: 1000, unlimited: false, used: 0, reserved: 0 });
  });
});

test('B2: a reservation is held while work is in flight and released when it settles', async () => {
  await withRuntime(async (_store, kernel) => {
    kernel.reserveNodeTokens('t1', 'a', { budget: 1000, unlimited: false }, 400);
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }).reserved).toBe(400);
    kernel.releaseNodeTokens('t1', 'a', 400);
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }).reserved).toBe(0);
  });
});

test('B3: committed usage counts once, and re-committing the same total is idempotent', async () => {
  await withRuntime(async (_store, kernel) => {
    kernel.commitNodeUsage('t1', 'a', 120);
    kernel.commitNodeUsage('t1', 'a', 120);
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }).used).toBe(120);
    kernel.commitNodeUsage('t1', 'a', 180);
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }).used).toBe(180);
  });
});

test('B4: a reservation beyond the budget is refused and leaves nothing reserved', async () => {
  await withRuntime(async (_store, kernel) => {
    const budget = { budget: 500, unlimited: false };
    kernel.reserveNodeTokens('t1', 'a', budget, 300);
    expect(() => kernel.reserveNodeTokens('t1', 'a', budget, 300)).toThrow(/budget/i);
    // The refused reservation must not have been taken: the first one still stands alone.
    expect(kernel.budgetState('t1', 'a', budget).reserved).toBe(300);
  });
});

test('B5: an unlimited node is never refused', async () => {
  await withRuntime(async (_store, kernel) => {
    const budget = { budget: 0, unlimited: true };
    kernel.reserveNodeTokens('t1', 'b', budget, 10_000_000);
    expect(kernel.budgetState('t1', 'b', budget).reserved).toBe(10_000_000);
  });
});

test('nodes meter independently of one another', async () => {
  await withRuntime(async (_store, kernel) => {
    const budget = { budget: 500, unlimited: false };
    kernel.commitNodeUsage('t1', 'a', 400);
    expect(kernel.budgetState('t1', 'b', budget).used).toBe(0);
    expect(() => kernel.reserveNodeTokens('t1', 'a', budget, 200)).toThrow(/budget/i);
  });
});