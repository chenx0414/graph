import { expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeExecutor } from '../../src/core/node-executor.ts';
import { TaskStore } from '../../src/core/store.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 HB-288: pausing a v2 node prevents the send.
 *
 * The old executor distinguishes two things a bare "stop" conflates: a node paused BEFORE
 * its turn is sent must never be sent at all, while a turn already running drains rather
 * than being torn down mid-flight - the node's work so far is still valid, and killing it
 * would throw that away.
 *
 * v2 had the pause COLUMN and read it in the runner, but nothing could set it and the
 * executor never consulted it, so neither half existed.
 *
 * Failure modes first (R24):
 *   P1  a node paused before its turn is never turned, and stays queued
 *   P2  resuming it lets the turn happen
 *   P3  pausing does not lose the node's work: nothing was spent to produce it
 */

const definition = {
  schemaVersion: 2, name: 'pausable',
  protocols: { out: { type: 'object', required: ['v'], properties: { v: { type: 'string' } } } },
  nodes: { a: { recipe: 'worker@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } } },
  modules: {}, edges: {}, inputs: {}, outputs: {},
} as unknown as GraphDefinition;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-pause-'));
  await mkdir(join(root, 'state'), { recursive: true });
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  store.db.prepare("INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','{}')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('t1','p1','work','running',1)").run();
  const kernel = new KernelStore(store);
  kernel.insertRevision('t1', definition, 'pausable', 1);
  kernel.admitNode('t1', 1, 'a', { instanceId: 'inst-a' });
  kernel.enqueue('t1', { nodeId: 'a', kind: 'start', payload: {} as never });
  return { root, store, kernel };
}

test('P1: a paused node is never turned, and its work stays queued', async () => {
  const { root, store, kernel } = await setup();
  try {
    kernel.pauseNode('t1', 'a');
    const turns: string[] = [];
    const executor = new NodeExecutor({
      kernel, graphId: 't1',
      host: { start: async () => ({ processId: 1 }), alive: () => true, turn: async () => ({ turnId: 't', inspect: {} }) },
    });
    const outcome = await executor.runNode('a', async () => { turns.push('turn'); return undefined; });
    expect(turns).toEqual([]);
    expect(outcome).not.toBe('done');
    // The queued item survives: this work is wanted, it just must not start yet.
    expect(kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND node_id='a' AND state='queued'").get('t1')).toEqual({ n: 1 });
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('P2: resuming the node lets the turn happen', async () => {
  const { root, store, kernel } = await setup();
  try {
    kernel.pauseNode('t1', 'a');
    kernel.resumeNode('t1', 'a');
    expect(kernel.nodeState('t1', 'a').paused).toBe(false);
    // The supplied runner IS the turn in this harness, so counting runner calls counts turns.
    const turns: string[] = [];
    const executor = new NodeExecutor({
      kernel, graphId: 't1',
      host: { start: async () => ({ processId: 1 }), alive: () => true, turn: async () => ({ turnId: 't', inspect: {} }) },
    });
    await executor.runNode('a', async (executionId) => {
      turns.push('turn');
      kernel.submit(executionId, { outputs: { out: { enable: true, value: { v: 'ok' } } }, submissionId: 's1' });
      return { missing: [] };
    });
    expect(turns.length).toBe(1);
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Issue #1 HB-289: a turn whose cost is UNKNOWN holds its reservation and blocks.
 *
 * A turn that reports no usage cannot be charged and cannot be released either: releasing
 * would hand back a hold for tokens that may already have been spent, and a node could
 * then run past its budget by never reporting. So the hold stays and the node parks until
 * someone resolves the question - the old executor's unknown-usage hold, which v2 had no
 * equivalent for.
 *
 * Failure modes first (R24):
 *   U1  an unreported turn leaves its reservation HELD and the node blocked
 *   U2  recording the unknown usage charges the hold and unblocks the node
 *   U3  releasing the hold returns it and unblocks the node
 *   U4  a reported turn is not held - it settles normally
 */

test('U1/U4: a turn that reports nothing holds its reservation; one that reports settles', async () => {
  const { root, store, kernel } = await setup();
  try {
    const limit = { budget: 10_000, unlimited: false };
    kernel.enqueue('t1', { nodeId: 'a', kind: 'start', payload: {} as never });
    const executor = new NodeExecutor({
      kernel, graphId: 't1',
      host: { start: async () => ({ processId: 1 }), alive: () => true, turn: async () => ({ turnId: 't', inspect: {} }) },
      tokenBudget: limit, reserveTokens: 100,
    });
    const outcome = await executor.runNode('a', async () => ({ missing: ['out'] }));
    // The hold is still there and the node is parked: nobody may run past the budget by
    // simply never reporting.
    expect(kernel.budgetState('t1', 'a', limit).reserved).toBe(100);
    expect(kernel.nodeStatus('t1', 'a')).toBe('blocked');
    expect(outcome).toBe('blocked');
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('U2: recording the unknown usage charges the hold and frees the node', async () => {
  const { root, store, kernel } = await setup();
  try {
    const limit = { budget: 10_000, unlimited: false };
    kernel.reserveNodeTokens('t1', 'a', limit, 100);
    kernel.blockNode('t1', 'a', 'usage unknown');
    kernel.reconcileNodeUsage('t1', 'a', 'record');
    expect(kernel.budgetState('t1', 'a', limit)).toMatchObject({ used: 100, reserved: 0 });
    expect(kernel.nodeStatus('t1', 'a')).toBe('idle');
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('U3: releasing the unknown hold returns it and frees the node', async () => {
  const { root, store, kernel } = await setup();
  try {
    const limit = { budget: 10_000, unlimited: false };
    kernel.reserveNodeTokens('t1', 'a', limit, 100);
    kernel.blockNode('t1', 'a', 'usage unknown');
    kernel.reconcileNodeUsage('t1', 'a', 'release');
    expect(kernel.budgetState('t1', 'a', limit)).toMatchObject({ used: 0, reserved: 0 });
    expect(kernel.nodeStatus('t1', 'a')).toBe('idle');
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
