import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeExecutor } from '../../src/core/node-executor.ts';
import { TaskStore } from '../../src/core/store.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 HB-285: a v2 node that cannot afford its turn is blocked, not run.
 *
 * HB-284 gave the kernel a ledger; this wires it into the executor. The old kernel blocks a
 * node whose instance budget is exhausted and leaves it blocked until the user answers;
 * a v2 node that ignored its budget would simply run, which is the resource risk the
 * ledger exists to prevent.
 *
 * Failure modes first (R24):
 *   M1  a node with budget reserves it, runs, and settles - nothing is left reserved
 *   M2  a node whose budget cannot cover the turn is BLOCKED and never turns
 *   M3  a blocked node is not an execution failure - it stays blocked, waiting for an answer
 *   M4  the reservation is released when the turn fails, so a later attempt is not starved
 */

const definition = {
  schemaVersion: 2,
  name: 'metered',
  protocols: { out: { type: 'object', required: ['v'], properties: { v: { type: 'string' } } } },
  nodes: {
    a: { recipe: 'worker@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } },
  },
  modules: {}, edges: {}, inputs: {}, outputs: {},
} as unknown as GraphDefinition;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-block-'));
  const store = new TaskStore(join(root, 'state.db'));
  store.db.prepare("INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','{}')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('t1','p1','work','running',1)").run();
  const kernel = new KernelStore(store);
  kernel.insertRevision('t1', definition, 'metered', 1);
  kernel.admitNode('t1', 1, 'a', { instanceId: 'inst-a' });
  kernel.enqueue('t1', { nodeId: 'a', kind: 'start', payload: {} as never });
  return { root, store, kernel };
}

const hostThatTurns = (calls: string[]) => ({
  start: async () => ({ processId: 1 }),
  alive: () => true,
  turn: async () => {
    calls.push('turn');
    return { turnId: 't', inspect: {} };
  },
});

test('M1/M3/M4: a node that cannot afford its turn is blocked, keeps its state, and reserves nothing', async () => {
  const { root, store, kernel } = await setup();
  try {
    const calls: string[] = [];
    const executor = new NodeExecutor({
      kernel, graphId: 't1', host: hostThatTurns(calls),
      // The budget cannot cover the reservation the turn needs.
      tokenBudget: { budget: 10, unlimited: false },
      reserveTokens: 1000,
    });
    const outcome = await executor.runNode('a', async () => undefined);

    // M2/M3: blocked is not `failed` - it is a state the operator can act on.
    expect(outcome).toBe('blocked');
    // The node never turned, so nothing was spent trying.
    expect(calls).toEqual([]);
    expect(kernel.nodeStatus('t1', 'a')).toBe('blocked');
    // M4: a refused reservation leaves nothing held.
    expect(kernel.budgetState('t1', 'a', { budget: 10, unlimited: false }).reserved).toBe(0);
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('M1: a node within budget runs, and its reservation is settled afterwards', async () => {
  const { root, store, kernel } = await setup();
  try {
    const executor = new NodeExecutor({
      kernel, graphId: 't1', host: hostThatTurns([]),
      tokenBudget: { budget: 10_000, unlimited: false },
      reserveTokens: 100,
    });
    // The turn submits, so the execution settles and the hold is released.
    const outcome = await executor.runNode('a', async (executionId) => {
      kernel.submit(executionId, { outputs: { out: { enable: true, value: { v: 'ok' } } }, submissionId: 's1' });
      return { missing: [] };
    });
    // The runner IS the turn in this harness, so submitting through it is the turn.
    expect(outcome).toBe('done');
    expect(kernel.budgetState('t1', 'a', { budget: 10_000, unlimited: false }).reserved).toBe(0);
    expect(outcome).not.toBe('blocked');
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});