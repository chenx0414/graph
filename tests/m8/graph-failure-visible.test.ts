import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Execution } from '../../src/core/execution.ts';
import { TaskStore } from '../../src/core/store.ts';

/**
 * Issue #1 §13.8 (HB-272) — a v2 graph that cannot run must be visible.
 *
 * The graph lane runs inside the host tick, which fires every 40ms. When a graph threw,
 * the tick swallowed the error and moved on, so a graph that could never start looked
 * exactly like a graph with nothing to do: the queue stayed full and nothing said why.
 * Debugging that cost a real detour — the lane was visibly "dispatched" while every node
 * silently did nothing.
 *
 * Failure modes first (R24):
 *   E1  a graph that throws leaves a task event naming the reason
 *   E2  the same graph is not retried into a flood — one event, then the tick moves on
 *   E3  a lane that cannot even list its graphs is reported, not hidden
 *   E4  a healthy graph produces no failure event
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-failure-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('g1','p','r',1,'running')").run();
  return store;
}

function failures(store: TaskStore): { type: string; data: Record<string, unknown> }[] {
  return (store.db.prepare("SELECT type, data FROM events WHERE task_id='g1' AND type LIKE 'graph.%' ORDER BY rowid").all() as { type: string; data: string }[])
    .map(row => ({ type: row.type, data: JSON.parse(row.data) as Record<string, unknown> }));
}

test('E1: a graph that throws leaves a task event naming the reason', async () => {
  const store = await fixture();
  const execution = new Execution(store, {}, {
    graphs: () => [{ taskId: 'g1', run: async () => { throw new Error('no credential bound for model local'); } }],
  });
  await execution.pump();
  const seen = failures(store);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.type).toBe('graph.failed');
  expect(String(seen[0]!.data.reason)).toContain('no credential bound');
});

test('E2: the same failing graph is reported once, not flooded on every tick', async () => {
  const store = await fixture();
  const execution = new Execution(store, {}, {
    graphs: () => [{ taskId: 'g1', run: async () => { throw new Error('still broken'); } }],
  });
  await execution.pump();
  await execution.pump();
  await execution.pump();
  expect(failures(store)).toHaveLength(1);
});

test('E3: a lane that cannot even list its graphs is reported, not hidden', async () => {
  const store = await fixture();
  const execution = new Execution(store, {}, {
    graphs: () => { throw new Error('the kernel is missing its tables'); },
  });
  await execution.pump();
  // A lane that cannot name a task is not attributable to one, so the failure is recorded
  // against the runtime rather than silently dropped.
  const global = store.db.prepare("SELECT data FROM events WHERE type='graph.failed'").all() as { data: string }[];
  expect(global).toHaveLength(1);
  expect(JSON.parse(global[0]!.data).reason).toContain('kernel');
});

test('E4: a healthy graph produces no failure event', async () => {
  const store = await fixture();
  const execution = new Execution(store, {}, {
    graphs: () => [{ taskId: 'g1', run: async () => ({ drained: true }) }],
  });
  await execution.pump();
  expect(failures(store)).toEqual([]);
});
