import { test, expect } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import {
  TOOL_CALL_SPOOL_DIR, clearToolCallSpools, ingestToolCallSpools, spoolToolCall, toolCallSpoolPath,
} from '../../src/runtime/tool-call-spool.ts';

function open() {
  const stateDir = mkdtempSync(join(tmpdir(), 'tool-spool-'));
  return { stateDir, store: new TaskStore(join(stateDir, 'tasks.sqlite')) };
}

// A worker lane writes its calls where the daemon can see them, and reading the statistics is what
// folds them in. The whole outward behaviour of the spool is: file in, attributed rows out, once.
test('folds a worker lane spool into the statistics, and only once', async () => {
  const { stateDir, store } = open();
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', stateDir, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','tool-call spool',1)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','lane','{\"role\":\"coder\"}','worker-1')").run();
  });
  await spoolToolCall(stateDir, 'worker-1', { tool: 'bash', ms: 40, isError: false });
  await spoolToolCall(stateDir, 'worker-1', { tool: 'edit', ms: 90, isError: true });

  expect(await ingestToolCallSpools(store, stateDir)).toBe(2);
  // The stored offset is the record: the same file cannot be counted twice.
  expect(await ingestToolCallSpools(store, stateDir)).toBe(0);
  const stats = store.toolCallStats();
  expect(stats.find(entry => entry.tool === 'edit')).toMatchObject({ calls: 1, errors: 1, role: 'coder' });
  expect(stats.find(entry => entry.tool === 'bash')).toMatchObject({ calls: 1, errors: 0, totalMs: 40, role: 'coder' });
});

// A worker appends while the daemon reads, so the last line is often half written. It must wait,
// not arrive as a broken row or as a dropped one. Fixture timestamps are current: the statistics
// prune anything older than the retention window, so a line dated in 1970 would be gone before it
// could be asserted.
test('waits for a half-written line instead of counting it', async () => {
  const { stateDir, store } = open();
  const file = toolCallSpoolPath(stateDir, 'worker-2');
  await mkdir(join(stateDir, TOOL_CALL_SPOOL_DIR), { recursive: true });
  await writeFile(file, `${JSON.stringify({ instanceId: 'worker-2', tool: 'read', ms: 10, isError: false, at: Date.now() })}\n{"instanceId":"worker-2","tool":"rea`);
  expect(await ingestToolCallSpools(store, stateDir)).toBe(1);

  await appendFile(file, `d","ms":20,"isError":false,"at":${Date.now()}}\n`);
  expect(await ingestToolCallSpools(store, stateDir)).toBe(1);
  expect(store.toolCallStats().find(entry => entry.tool === 'read')).toMatchObject({ calls: 2, totalMs: 30 });
});

// A file that shrank is not the file the offset describes anymore: the read starts over rather
// than slicing into the middle of a different line.
test('a truncated spool is read from the start rather than trusted', async () => {
  const { stateDir, store } = open();
  await spoolToolCall(stateDir, 'worker-3', { tool: 'agent_browser', ms: 5, isError: false });
  await spoolToolCall(stateDir, 'worker-3', { tool: 'ffgrep', ms: 6, isError: false });
  expect(await ingestToolCallSpools(store, stateDir)).toBe(2);

  await writeFile(toolCallSpoolPath(stateDir, 'worker-3'), `${JSON.stringify({ instanceId: 'worker-3', tool: 'grep', ms: 7, isError: false, at: Date.now() })}\n`);
  expect(await ingestToolCallSpools(store, stateDir)).toBe(1);
  expect(store.toolCallStats().find(entry => entry.tool === 'grep')).toMatchObject({ calls: 1 });
});

// The console's clear button means the sample is gone. If the spool survived it, the next read
// would quietly resurrect the calls the user just deleted.
test('clearing the sample removes the spool, so nothing is re-ingested', async () => {
  const { stateDir, store } = open();
  await spoolToolCall(stateDir, 'worker-4', { tool: 'bash', ms: 5, isError: false });
  await ingestToolCallSpools(store, stateDir);
  store.clearToolCalls();
  store.forgetToolCallSpools();
  await clearToolCallSpools(stateDir);

  expect(await ingestToolCallSpools(store, stateDir)).toBe(0);
  expect(store.toolCallStats()).toEqual([]);
});

// Telemetry observes turns; it never gets to break one. An unwritable spool is a missing sample.
test('an unwritable spool stays silent instead of failing the turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-spool-'));
  await writeFile(join(root, 'not-a-dir'), 'x');
  await expect(spoolToolCall(join(root, 'not-a-dir', 'nested'), 'worker-5', { tool: 'bash', ms: 1, isError: false }))
    .resolves.toBeUndefined();
});

// Two readers can ask at the same moment — the console fetches the tool numbers and the skill
// numbers together. The fold must still happen exactly once: a duplicated row doubles every count,
// and it did before this guard existed.
test('two concurrent reads fold a spool exactly once', async () => {
  const { stateDir, store } = open();
  await spoolToolCall(stateDir, 'worker-6', { tool: 'read', ms: 7, isError: false, target: '/tmp/skill/SKILL.md' });
  await spoolToolCall(stateDir, 'worker-6', { tool: 'bash', ms: 3, isError: false });

  const [first, second] = await Promise.all([
    ingestToolCallSpools(store, stateDir),
    ingestToolCallSpools(store, stateDir),
  ]);

  expect(store.toolCallStats().reduce((sum, entry) => sum + entry.calls, 0)).toBe(2);
  expect(first).toBe(2);
  expect(second).toBe(2);
  const targets = store.db.prepare('SELECT target FROM tool_calls ORDER BY id').all() as { target: string | null }[];
  expect(targets).toEqual([{ target: '/tmp/skill/SKILL.md' }, { target: null }]);
});
