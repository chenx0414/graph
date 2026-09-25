import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { applyRetention, planRetention } from '../../src/core/state-retention.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanups.reverse()) await action();
  cleanups.length = 0;
});

/** Only the tables the retention rules touch; the real schema is exercised by the
 *  dry run against a copy of the live database. */
function db(now: number) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE tasks(id TEXT PRIMARY KEY, request TEXT NOT NULL);
    CREATE TABLE operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
      state TEXT NOT NULL, settled_at INTEGER);
    CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL,
      data TEXT NOT NULL, timestamp INTEGER NOT NULL);
    CREATE TABLE node_capabilities(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
      operation_id TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 0, loaded TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
    CREATE TABLE context_handoffs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      version INTEGER NOT NULL, purpose TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      package TEXT NOT NULL DEFAULT '', digest TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  `);
  const day = 86_400_000;
  const old = now - 5 * day;
  const insert = (sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).run(...values);
  insert('INSERT INTO tasks(id,request) VALUES(?,?)', 'settled', 'old work');
  insert('INSERT INTO tasks(id,request) VALUES(?,?)', 'live', 'current work');
  // A settled task: every operation has a settled_at.
  insert('INSERT INTO operations(id,task_id,node_id,state,settled_at) VALUES(?,?,?,?,?)', 's1', 'settled', 'work', 'succeeded', old);
  insert('INSERT INTO operations(id,task_id,node_id,state,settled_at) VALUES(?,?,?,?,?)', 's2', 'settled', 'check', 'succeeded', old);
  // A task with work still in flight.
  insert('INSERT INTO operations(id,task_id,node_id,state,settled_at) VALUES(?,?,?,?,?)', 'l1', 'live', 'master', 'dispatched', null);
  insert('INSERT INTO operations(id,task_id,node_id,state,settled_at) VALUES(?,?,?,?,?)', 'l2', 'live', 'master', 'succeeded', old);
  const event = (task: string, type: string, size: number, at: number) =>
    insert('INSERT INTO events(task_id,type,data,timestamp) VALUES(?,?,?,?)', task, type, 'x'.repeat(size), at);
  event('settled', 'task.created', 5000, old); // the first event of a task, always survives
  event('settled', 'requirement.changed', 5000, old + 1); // also survives, even when the window is small
  for (let index = 0; index < 260; index += 1) event('settled', 'node.entry', 100, old + 2 + index);
  event('live', 'node.entry', 100, now - 1000);
  // A stale batch: abandoned work leaves not_sent operations behind, and they must
  // not pin the task's event stream forever.
  insert('INSERT INTO tasks(id,request) VALUES(?,?)', 'stale', 'abandoned batch');
  insert('INSERT INTO operations(id,task_id,node_id,state,settled_at) VALUES(?,?,?,?,?)', 'p1', 'stale', 'work', 'not_sent', null);
  for (let index = 0; index < 260; index += 1) event('stale', 'node.entry', 100, old + index);
  for (const at of [old, old + 1, old + 2]) {
    insert('INSERT INTO node_capabilities(task_id,node_id,operation_id,loaded,created_at) VALUES(?,?,?,?,?)', 'settled', 'work', 's1', '{}', at);
  }
  insert('INSERT INTO node_capabilities(task_id,node_id,operation_id,loaded,created_at) VALUES(?,?,?,?,?)', 'live', 'master', 'l1', '{}', now - 1000);
  for (const [index, operation] of ['s1', 's1', 's2'].entries()) {
    insert('INSERT INTO context_handoffs(id,task_id,operation_id,version,created_at) VALUES(?,?,?,?,?)',
      `h${index}`, 'settled', operation, index + 1, old + index);
  }
  return { sqlite, now, day, old };
}

test('keeps the newest events per task and always keeps the requirement history', () => {
  const { sqlite, now, old } = db(Date.now());
  const options = { now, keepEventsPerTask: 200, keepCapabilitiesPerNode: 1, keepHandoffsPerOperation: 1, minAgeMs: 86_400_000 };
  applyRetention(sqlite, options);
  const kept = sqlite.prepare('SELECT type, count(*) AS n FROM events WHERE task_id=? GROUP BY type').all('settled') as { type: string; n: number }[];
  const byType = Object.fromEntries(kept.map(row => [row.type, row.n]));
  expect(byType['node.entry']).toBe(200);
  expect(byType['task.created']).toBe(1);
  expect(byType['requirement.changed']).toBe(1);
  // The newest events are the ones that stay, so the task's updatedAt cannot move.
  const newest = sqlite.prepare('SELECT MAX(timestamp) AS t FROM events WHERE task_id=?').get('settled') as { t: number };
  expect(newest.t).toBe(old + 2 + 259);
});

test('never touches a task whose work is still in flight', () => {
  const { sqlite, now } = db(Date.now());
  const before = sqlite.prepare('SELECT count(*) AS n FROM events WHERE task_id=?').get('live') as { n: number };
  const options = { now, keepEventsPerTask: 0, keepCapabilitiesPerNode: 0, keepHandoffsPerOperation: 0, minAgeMs: 0 };
  applyRetention(sqlite, options);
  const after = sqlite.prepare('SELECT count(*) AS n FROM events WHERE task_id=?').get('live') as { n: number };
  expect(after.n).toBe(before.n);
  expect((sqlite.prepare('SELECT count(*) AS n FROM node_capabilities WHERE task_id=?').get('live') as { n: number }).n).toBe(1);
});

test('never touches a task that was active within the minimum age', () => {
  const { sqlite, now } = db(Date.now());
  const plan = planRetention(sqlite, { now, keepEventsPerTask: 0, keepCapabilitiesPerNode: 1, keepHandoffsPerOperation: 1, minAgeMs: 86_400_000 });
  // The settled task is five days old, the live one is one second old but also in flight.
  expect(plan.events).toBeGreaterThan(0);
  expect(plan.capabilities).toBe(2);
  expect(plan.handoffs).toBe(1);
});

test('a stale not_sent operation does not pin a task forever', () => {
  const { sqlite, now } = db(Date.now());
  const options = { now, keepEventsPerTask: 200, keepCapabilitiesPerNode: 1, keepHandoffsPerOperation: 1, minAgeMs: 86_400_000 };
  applyRetention(sqlite, options);
  expect((sqlite.prepare('SELECT count(*) AS n FROM events WHERE task_id=?').get('stale') as { n: number }).n).toBe(200);
});

test('keeps the newest capability row per node and the newest handoff per operation', () => {
  const { sqlite, now } = db(Date.now());
  const options = { now, keepEventsPerTask: 200, keepCapabilitiesPerNode: 1, keepHandoffsPerOperation: 1, minAgeMs: 86_400_000 };
  applyRetention(sqlite, options);
  const capabilities = sqlite.prepare('SELECT seq FROM node_capabilities WHERE task_id=? ORDER BY seq').all('settled') as { seq: number }[];
  expect(capabilities).toEqual([{ seq: 3 }]);
  const handoffs = sqlite.prepare('SELECT id FROM context_handoffs WHERE task_id=? ORDER BY version').all('settled') as { id: string }[];
  expect(handoffs).toEqual([{ id: 'h1' }, { id: 'h2' }]);
  // The next handoff version comes from MAX(version), so the newest version must survive.
  expect((sqlite.prepare('SELECT MAX(version) AS v FROM context_handoffs WHERE task_id=?').get('settled') as { v: number }).v).toBe(3);
});

test('a dry run changes nothing and reports what the apply really deletes', () => {
  const { sqlite, now } = db(Date.now());
  const options = { now, keepEventsPerTask: 200, keepCapabilitiesPerNode: 1, keepHandoffsPerOperation: 1, minAgeMs: 86_400_000 };
  const before = sqlite.prepare('SELECT count(*) AS n FROM events').get();
  const plan = planRetention(sqlite, options);
  expect(sqlite.prepare('SELECT count(*) AS n FROM events').get()).toEqual(before);
  const applied = applyRetention(sqlite, options);
  expect(applied).toEqual({ events: plan.events, capabilities: plan.capabilities, handoffs: plan.handoffs });
});

test('a second run finds nothing left to delete', () => {
  const { sqlite, now } = db(Date.now());
  const options = { now, keepEventsPerTask: 200, keepCapabilitiesPerNode: 1, keepHandoffsPerOperation: 1, minAgeMs: 86_400_000 };
  applyRetention(sqlite, options);
  const again = planRetention(sqlite, options);
  expect(again).toEqual({ events: 0, capabilities: 0, handoffs: 0, bytes: 0 });
});

test('an empty database is a no-op', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graph-retention-empty-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  // A untouched store: the rules must be a no-op on the real schema, not only on a stub.
  const sqlite = new TaskStore(join(dir, 'empty.sqlite')).db;
  const options = { now: Date.now(), keepEventsPerTask: 200, keepCapabilitiesPerNode: 1, keepHandoffsPerOperation: 1, minAgeMs: 0 };
  expect(planRetention(sqlite, options)).toEqual({ events: 0, capabilities: 0, handoffs: 0, bytes: 0 });
  expect(applyRetention(sqlite, options)).toEqual({ events: 0, capabilities: 0, handoffs: 0 });
  sqlite.close();
});
