import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('task view bounds history while preserving live reservations outside the window; cursors reach every attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-task-history-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }] });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'history', requestId: 'start' });
  const writer = new TaskStore(join(root, 'state/tasks.sqlite'));
  cleanup.push(async () => writer.close());
  writer.transaction(() => {
    writer.db.prepare("INSERT INTO nodes(task_id,id,spec,status) VALUES(?,'check',?,'running')")
      .run(taskId, canonicalJson({ id: 'check', kind: 'program', action: 'check' }));
    const insert = writer.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,dispatched_at,settled_at)
      VALUES(?,?,'check',1,?,?,?,?,?,?)`);
    for (let i = 0; i < 125; i++) {
      insert.run(`op-${i}`, taskId, canonicalJson({ id: `op-${i}`, taskId, nodeId: 'check' }),
        i === 0 ? 'dispatched' : 'not_sent', i === 0 ? 77 : 0, Number(i === 0), 1000 + i, i ? 2000 + i : null);
      writer.event(taskId, 'operation.not_sent', { operationId: `op-${i}` });
    }
    writer.db.prepare('UPDATE tasks SET paused=1 WHERE id=?').run(taskId);
  });
  const view = await runtime.user.task(taskId).view();
  expect(view.operations).toHaveLength(50);
  expect(view.operations[0]?.id).toBe('op-75');
  expect(view.operationHistory).toMatchObject({ total: 125, hasOlder: true });
  expect(view.status).toBe('pausing');
  expect(view.nodes.find(node => node.id === 'check')?.reserved).toBe(77);
  const seen: string[] = [];
  let before: string | undefined;
  do {
    const page = runtime.operations(taskId, { latest: true, nodeId: 'check', limit: 30, ...(before ? { before } : {}) });
    seen.unshift(...page.map(op => op.id));
    before = page[0]?.id;
    if (!page.length) break;
  } while (before);
  expect(seen).toEqual(Array.from({ length: 125 }, (_, i) => `op-${i}`));
  expect(runtime.operations(taskId, { after: 'op-120', limit: 2 }).map(op => op.id)).toEqual(['op-121', 'op-122']);
  expect(runtime.operations(taskId, { latest: true, limit: 1 })[0]).toMatchObject({ startedAt: 1124, endedAt: 2124, durationMs: 1000 });
});

test('task timestamps and event cursors use covering indexes after upgrading the existing database', () => {
  const store = new TaskStore(':memory:');
  try {
    for (const sql of [
      "SELECT MAX(timestamp) FROM events WHERE task_id='t'",
      "SELECT cursor FROM events WHERE task_id='t' AND cursor>100 ORDER BY cursor LIMIT 100",
    ]) {
      const plans = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
      expect(plans.map(row => row.detail).join('\n')).toMatch(/USING COVERING INDEX events_task_/);
    }
  } finally { store.close(); }
});
