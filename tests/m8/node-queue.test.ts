import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeQueue } from '../../src/core/node-queue.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §7, §14 — one queue per node, serialized chat + interface input, with
 * retry counter semantics that survive a restart.
 *
 * Failure modes first (R24):
 *   Q1  two inputs accepted out of order                       -> processed in acceptance order
 *   Q2  two executions for one node at once                    -> impossible (one at a time)
 *   Q3  chat during a running turn                             -> queued, never injected mid-turn
 *   Q4  a failed node pauses its own queue, others continue    -> only that node stops draining
 *   Q5  retry counters reset on restart                        -> must NOT reset
 *   Q6  auto-resubmit used twice                               -> only once
 *   Q7  after a successful submit, a re-sent original input    -> refused
 */

const stores: TaskStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function openKernel(dir: string) {
  const taskStore = new TaskStore(join(dir, 'state.db'));
  stores.push(taskStore);
  const kernel = new KernelStore(taskStore);
  taskStore.db.prepare('INSERT OR IGNORE INTO projects(id,root,grants) VALUES(?,?,?)').run('p1', dir, '[]');
  taskStore.db.prepare('INSERT OR IGNORE INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq) VALUES(?,?,?,?,?,?)').run('t1', 'p1', 'go', 1, 0, 1);
  return { taskStore, kernel };
}

const definition = (): GraphDefinition => ({
  schemaVersion: 2, name: 'q',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'a@1', task: 'a', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
  },
  modules: {}, edges: {}, inputs: {}, outputs: {},
});

describe('NodeQueue — acceptance order and serial drain (§7)', () => {
  let kernel: KernelStore;
  let queue: NodeQueue;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'graph-nodeq-'));
    dirs.push(dir);
    const opened = await openKernel(dir);
    kernel = opened.kernel;
    const revision = kernel.publishRevision('t1', { definition: definition(), reason: 'plan' });
    kernel.admitNode('t1', revision.version, 'a', { instanceId: 'i-a' });
    kernel.admitNode('t1', revision.version, 'b', { instanceId: 'i-b' });
    queue = new NodeQueue(kernel, 't1');
  });

  test('Q1: inputs are processed in acceptance order, one execution at a time', async () => {
    queue.enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { n: 1 } });
    queue.enqueue({ nodeId: 'a', kind: 'chat', text: 'second' });
    queue.enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { n: 3 } });
    const first = queue.claim('a');
    expect(first?.kind).toBe('delivery');
    // While one is claimed, the node has no second claimable item.
    expect(queue.claim('a')).toBeNull();
    queue.complete(first!.seq, { kind: 'submitted' });
    const second = queue.claim('a');
    expect(second?.kind).toBe('chat');
    queue.complete(second!.seq, { kind: 'submitted' });
    expect(queue.claim('a')?.kind).toBe('delivery');
  });

  test('Q2: an independent node keeps its own queue and drains regardless of another node', async () => {
    queue.enqueue({ nodeId: 'a', kind: 'chat', text: 'a1' });
    queue.enqueue({ nodeId: 'b', kind: 'chat', text: 'b1' });
    expect(queue.claim('a')?.kind).toBe('chat');
    // b is independent and still claimable while a is busy.
    expect(queue.claim('b')?.kind).toBe('chat');
  });

  test('Q4: a failed node pauses its own queue; its items stay pending, others drain', async () => {
    queue.enqueue({ nodeId: 'a', kind: 'chat', text: 'a1' });
    queue.enqueue({ nodeId: 'a', kind: 'chat', text: 'a2' });
    queue.enqueue({ nodeId: 'b', kind: 'chat', text: 'b1' });
    const claimed = queue.claim('a')!;
    queue.complete(claimed.seq, { kind: 'failed', reason: 'boom' });
    expect(queue.paused('a')).toBe(true);
    expect(queue.claim('a')).toBeNull();
    // b is unaffected.
    expect(queue.claim('b')?.kind).toBe('chat');
    // Resume releases the pause; the pending item is still there.
    queue.resume('a');
    expect(queue.claim('a')?.kind).toBe('chat');
  });

  test('Q3: a chat accepted while a turn runs is queued, never injected mid-turn', async () => {
    queue.enqueue({ nodeId: 'a', kind: 'chat', text: 'running' });
    const claimed = queue.claim('a')!;
    const queued = queue.enqueue({ nodeId: 'a', kind: 'chat', text: 'during' });
    expect(queued.state).toBe('queued');
    // The running claim is untouched and the new chat cannot be claimed yet.
    expect(queue.claim('a')).toBeNull();
    queue.complete(claimed.seq, { kind: 'submitted' });
    expect((queue.claim('a')?.payload as { text?: string }).text).toBe('during');
  });
});

describe('NodeQueue — retry counters survive restart (§7, §15.3)', () => {
  test('Q5/Q6/Q7: retries and resubmits are counted per node and persist across reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'graph-retry-'));
    dirs.push(dir);
    let opened = await openKernel(dir);
    let kernel = opened.kernel;
    const revision = kernel.publishRevision('t1', { definition: definition(), reason: 'plan' });
    kernel.admitNode('t1', revision.version, 'a', { instanceId: 'i-a' });
    let queue = new NodeQueue(kernel, 't1');

    // Default retry budget is 2 after the first attempt (3 attempts total).
    expect(queue.retryBudget('a')).toEqual({ attempts: 0, retriesAllowed: 2, resubmitsAllowed: 1, resubmitsUsed: 0 });
    queue.noteAttempt('a');
    queue.noteAttempt('a');
    expect(queue.retryBudget('a').attempts).toBe(2);
    queue.noteResubmit('a');
    expect(queue.retryBudget('a').resubmitsUsed).toBe(1);
    // The auto-resubmit budget is spent; a second is refused.
    expect(() => queue.noteResubmit('a')).toThrow();

    // Reopen the database: the counters must not reset.
    opened.taskStore.db.close();
    stores.splice(stores.indexOf(opened.taskStore), 1);
    opened = await openKernel(dir);
    kernel = opened.kernel;
    queue = new NodeQueue(kernel, 't1');
    expect(queue.retryBudget('a')).toEqual({ attempts: 2, retriesAllowed: 2, resubmitsAllowed: 1, resubmitsUsed: 1 });
  });

  test('a node may override the graph default retry budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'graph-retry2-'));
    dirs.push(dir);
    const { kernel } = await openKernel(dir);
    const revision = kernel.publishRevision('t1', { definition: definition(), reason: 'plan' });
    kernel.admitNode('t1', revision.version, 'a', { instanceId: 'i-a' });
    const queue = new NodeQueue(kernel, 't1', { defaultRetries: 2, defaultResubmits: 1 });
    queue.configure('a', { retriesAllowed: 4, resubmitsAllowed: 2 });
    expect(queue.retryBudget('a').retriesAllowed).toBe(4);
    expect(queue.retryBudget('a').resubmitsAllowed).toBe(2);
  });

  test('Q7: after a successful submit the input cannot be re-sent to that node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'graph-resend-'));
    dirs.push(dir);
    const { kernel } = await openKernel(dir);
    const revision = kernel.publishRevision('t1', { definition: definition(), reason: 'plan' });
    kernel.admitNode('t1', revision.version, 'a', { instanceId: 'i-a' });
    kernel.startExecution('t1', { executionId: 'exec-a', nodeId: 'a', revisionVersion: revision.version });
    kernel.submit('exec-a', { outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 'sub-a' });
    const queue = new NodeQueue(kernel, 't1');
    expect(() => queue.enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { n: 2 }, originalOf: 'exec-a' })).toThrow(/already submitted|re-send/i);
  });
});
