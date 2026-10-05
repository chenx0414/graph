import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Execution } from '../../src/core/execution.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

/**
 * Issue #1 §13.8 — the run hookup: the host loop must actually run a v2 graph.
 *
 * A task on the v2 kernel has no `nodes` rows, so `readyNodes()` can never see it and the
 * graph stays inert no matter how complete the kernel is. The drive loop therefore needs a
 * second lane that names v2 graphs with queued work and runs them. These tests hold the
 * contract of that lane at the executor surface, independent of how the graph is built.
 *
 * Failure modes first (R24):
 *   G1  a v2 graph with queued work is surfaced and run, and the drive loop counts it
 *   G2  a task with no v2 work is never surfaced — the lane proposes, the graph decides
 *   G3  a graph that throws does not kill the drive loop
 *   G4  a stopping executor stops dispatching v2 work
 *   G5  a paused task's graph is not run
 */

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-lane-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  for (const [id, seq] of [['g-v2', 1], ['g-other', 2]] as const) {
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES(?,?,?,?, 'running')").run(id, 'p', 'req', seq);
  }
  return store;
}

test('G1: the drive loop runs a v2 graph that has queued work and counts it', async () => {
  const store = await fixture();
  const ran: string[] = [];
  const execution = new Execution(store, {}, {
    graphs: () => ran.length ? [] : [{ taskId: 'g-v2', run: async () => { ran.push('g-v2'); return { drained: true }; } }],
  });
  const result = await execution.drive();
  expect(ran).toEqual(['g-v2']);
  expect(result.dispatched).toBeGreaterThanOrEqual(1);
});

test('G2: a graph that reports nothing to do is still only proposed by the lane, not run twice', async () => {
  const store = await fixture();
  // A drained graph is NOT named by the lane's proposer, so it is simply absent here.
  const execution = new Execution(store, {}, { graphs: () => [] });
  const result = await execution.drive();
  expect(result.dispatched).toBe(0);
});

test('G3: a graph that throws does not kill the drive loop, and the next graph still runs', async () => {
  const store = await fixture();
  const ran: string[] = [];
  const execution = new Execution(store, {}, {
    graphs: () => ran.length ? [] : [
      { taskId: 'g-v2', run: async () => { ran.push('boom'); throw new Error('graph exploded'); } },
      { taskId: 'g-other', run: async () => { ran.push('g-other'); return { drained: true }; } },
    ],
  });
  await expect(execution.drive()).resolves.toBeDefined();
  expect(ran).toEqual(['boom', 'g-other']);
});

test('G4: a stopping executor stops dispatching v2 work', async () => {
  const store = await fixture();
  const ran: string[] = [];
  const execution = new Execution(store, {}, {
    graphs: () => ran.length ? [] : [{ taskId: 'g-v2', run: async () => { ran.push('g-v2'); return { drained: true }; } }],
  });
  await execution.drain();
  await execution.drive();
  expect(ran).toEqual([]);
});

test('G5: a paused task is not runnable, so its graph is skipped', async () => {
  const store = await fixture();
  store.db.prepare("UPDATE tasks SET paused=1 WHERE id='g-v2'").run();
  const ran: string[] = [];
  const execution = new Execution(store, {}, {
    graphs: () => ran.length ? [] : [{ taskId: 'g-v2', run: async () => { ran.push('g-v2'); return { drained: true }; } }],
  });
  await execution.drive();
  expect(ran).toEqual([]);
});
