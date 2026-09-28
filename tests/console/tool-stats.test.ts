import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, SCHEMA_VERSION } from '../../src/core/store.ts';

function open(): { store: TaskStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'tool-stats-')), 'tasks.sqlite');
  return { store: new TaskStore(path), path };
}

// The statistics are the whole point of the table: what the console shows must follow from the
// recorded calls, not from how they were written.
test('aggregates calls, failures and durations per tool', () => {
  const { store } = open();
  store.recordToolCall({ instanceId: 'i1', tool: 'bash', ms: 100, isError: false });
  store.recordToolCall({ instanceId: 'i1', tool: 'bash', ms: 300, isError: true });
  store.recordToolCall({ instanceId: 'i1', tool: 'bash', ms: 1_000, isError: false });
  store.recordToolCall({ instanceId: 'i1', tool: 'read', ms: 50, isError: false });

  const stats = store.toolCallStats();
  const bash = stats.find(entry => entry.tool === 'bash');
  expect(bash).toMatchObject({ calls: 3, errors: 1, totalMs: 1_400, medianMs: 300, maxMs: 1_000 });
  expect(stats.find(entry => entry.tool === 'read')).toMatchObject({ calls: 1, errors: 0, totalMs: 50, medianMs: 50 });
  store.recordToolCall({ instanceId: 'i1', tool: 'bash', ms: 500, isError: false });
  expect(store.toolCallStats().find(entry => entry.tool === 'bash')?.medianMs).toBe(400);
  // Ordered by call count, so the console can render it as-is.
  expect(stats[0]!.tool).toBe('bash');
  expect(bash!.lastAt).toBeGreaterThan(0);
});

// An instance whose node is unknown must record that fact instead of inventing an owner.
test('records an unknown owner as null rather than guessing', () => {
  const { store } = open();
  store.recordToolCall({ instanceId: 'not-a-node', tool: 'bash', ms: 10, isError: false });
  expect(store.toolCallStats()[0]!).toMatchObject({ tool: 'bash', role: null, calls: 1 });
});

// The table is appended to for the life of the installation, so it has to survive a restart and
// stay bounded. Both are properties of the stored data, not of a single process.
test('survives a reopen and drops rows older than the retention window', () => {
  const { store, path } = open();
  store.recordToolCall({ instanceId: 'i1', tool: 'bash', ms: 10, isError: false });
  store.recordToolCall({
    instanceId: 'i1', tool: 'bash', ms: 10, isError: false,
    at: Date.now() - (TaskStore.TOOL_CALL_RETENTION_DAYS + 1) * 86_400_000,
  });
  store.db.close();

  const reopened = new TaskStore(path);
  const stats = reopened.toolCallStats();
  expect(stats).toHaveLength(1);
  expect(stats[0]!.calls).toBe(1);
});

test('clearing removes every recorded call', () => {
  const { store } = open();
  store.recordToolCall({ instanceId: 'i1', tool: 'bash', ms: 10, isError: false });
  store.recordToolCall({ instanceId: 'i1', tool: 'read', ms: 10, isError: true });
  expect(store.clearToolCalls()).toBe(2);
  expect(store.toolCallStats()).toEqual([]);
});

// A database written by an older build must gain the table without losing anything: this is the
// upgrade path every existing installation takes, not a fresh-database path.
test('adds the table to a database that predates it', () => {
  const { store, path } = open();
  store.recordToolCall({ instanceId: 'i1', tool: 'bash', ms: 10, isError: false });
  store.db.close();

  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE tool_calls; PRAGMA user_version=35;');
  raw.close();

  const upgraded = new TaskStore(path);
  expect(upgraded.toolCallStats()).toEqual([]);
  upgraded.recordToolCall({ instanceId: 'i1', tool: 'bash', ms: 10, isError: false });
  expect(upgraded.toolCallStats()[0]!.calls).toBe(1);
  const check = new DatabaseSync(path, { readOnly: true });
  expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
  check.close();
});
