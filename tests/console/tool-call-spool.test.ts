import { test, expect } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import {
  TOOL_CALL_SPOOL_DIR, clearToolCallSpools, ingestToolCallSpools, toolCallSpoolPath,
} from '../../src/runtime/tool-call-spool.ts';

function open() {
  const stateDir = mkdtempSync(join(tmpdir(), 'tool-spool-'));
  return { stateDir, store: new TaskStore(join(stateDir, 'tasks.sqlite')) };
}

/**
 * Lay down one spool file the way a lane leaves it on disk: one JSON record per line, current
 * timestamps (the statistics prune anything older than the retention window, so a line dated in
 * 1970 would be gone before it could be asserted). The write path itself is not here to be
 * asserted; what is under test is the fold: file in, attributed rows out, once.
 */
async function writeSpool(stateDir: string, instanceId: string, calls: { tool: string; ms: number; isError: boolean; target?: string }[]): Promise<void> {
  await mkdir(join(stateDir, TOOL_CALL_SPOOL_DIR), { recursive: true });
  await writeFile(
    toolCallSpoolPath(stateDir, instanceId),
    calls.map(call => `${JSON.stringify({ instanceId, ...call, ms: Math.max(0, Math.round(call.ms)), at: Date.now(), ...(call.target ? { target: call.target } : {}) })}\n`).join(''),
  );
}

// A lane's spool is what the daemon can see, and reading the statistics is what folds it in.
test('folds a worker lane spool into the statistics, and only once', async () => {
  const { stateDir, store } = open();
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', stateDir, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','tool-call spool',1)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','lane','{\"role\":\"coder\"}','worker-1')").run();
  });
  await writeSpool(stateDir, 'worker-1', [
    { tool: 'bash', ms: 40, isError: false },
    { tool: 'edit', ms: 90, isError: true },
  ]);

  expect(await ingestToolCallSpools(store, stateDir)).toBe(2);
  // The stored offset is the record: the same file cannot be counted twice.
  expect(await ingestToolCallSpools(store, stateDir)).toBe(0);
  const stats = store.toolCallStats();
  expect(stats.find(entry => entry.tool === 'edit')).toMatchObject({ calls: 1, errors: 1, role: 'coder' });
  expect(stats.find(entry => entry.tool === 'bash')).toMatchObject({ calls: 1, errors: 0, totalMs: 40, role: 'coder' });
});

// A worker appends while the daemon reads, so the last line is often half written. It must wait,
// not arrive as a broken row or as a dropped one.
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
  await writeSpool(stateDir, 'worker-3', [
    { tool: 'agent_browser', ms: 5, isError: false },
    { tool: 'ffgrep', ms: 6, isError: false },
  ]);
  expect(await ingestToolCallSpools(store, stateDir)).toBe(2);

  await writeSpool(stateDir, 'worker-3', [{ tool: 'grep', ms: 7, isError: false }]);
  expect(await ingestToolCallSpools(store, stateDir)).toBe(1);
  expect(store.toolCallStats().find(entry => entry.tool === 'grep')).toMatchObject({ calls: 1 });
});

// The console's clear button means the sample is gone. If the spool survived it, the next read
// would quietly resurrect the calls the user just deleted.
test('clearing the sample removes the spool, so nothing is re-ingested', async () => {
  const { stateDir, store } = open();
  await writeSpool(stateDir, 'worker-4', [{ tool: 'bash', ms: 5, isError: false }]);
  await ingestToolCallSpools(store, stateDir);
  store.clearToolCalls();
  store.forgetToolCallSpools();
  await clearToolCallSpools(stateDir);

  expect(await ingestToolCallSpools(store, stateDir)).toBe(0);
  expect(store.toolCallStats()).toEqual([]);
});

// Telemetry observes turns; it never gets to break one. A spool path that cannot be read at all -
// something that is not a directory - is a missing sample, and the read still answers.
test('an unreadable spool path stays silent instead of failing the read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-spool-'));
  await writeFile(join(root, 'not-a-dir'), 'x');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  await expect(ingestToolCallSpools(store, join(root, 'not-a-dir', 'nested'))).resolves.toBe(0);
  expect(store.toolCallStats()).toEqual([]);
});

// Two readers can ask at the same moment — the console fetches the tool numbers and the skill
// numbers together. The fold must still happen exactly once: a duplicated row doubles every count,
// and it did before this guard existed.
test('two concurrent reads fold a spool exactly once', async () => {
  const { stateDir, store } = open();
  await writeSpool(stateDir, 'worker-6', [
    { tool: 'read', ms: 7, isError: false, target: '/tmp/skill/SKILL.md' },
    { tool: 'bash', ms: 3, isError: false },
  ]);

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

// The state directory a worker lane receives is its own instance directory (its session lives
// there), so that is where its spool lands. Reading only the daemon's own root would report zero
// for every lane while the samples sit on disk — the whole outward behaviour of a lane's numbers
// depends on the read knowing both places.
test('folds a lane spool written inside the instance directory the lane was given', async () => {
  const { stateDir, store } = open();
  const instanceDir = join(stateDir, 'instances', 'worker-5');
  await writeSpool(instanceDir, 'worker-5', [
    { tool: 'read', ms: 30, isError: false, target: '/p/.agents/skills/heartbeat/SKILL.md' },
    { tool: 'bash', ms: 11, isError: false },
  ]);

  expect(await ingestToolCallSpools(store, stateDir)).toBe(2);
  // One convention, one offset: the instance file is not counted again either.
  expect(await ingestToolCallSpools(store, stateDir)).toBe(0);
  expect(store.toolCallStats().find(entry => entry.tool === 'read')).toMatchObject({ calls: 1, totalMs: 30 });
});

// Clearing from the console means the sample is gone, wherever it was written.
test('clearing the sample also removes what a lane spooled in its instance directory', async () => {
  const { stateDir, store } = open();
  await writeSpool(join(stateDir, 'instances', 'worker-6'), 'worker-6', [{ tool: 'bash', ms: 9, isError: false }]);
  expect(await ingestToolCallSpools(store, stateDir)).toBe(1);
  store.clearToolCalls();
  store.forgetToolCallSpools();
  await clearToolCallSpools(stateDir);

  expect(await ingestToolCallSpools(store, stateDir)).toBe(0);
  expect(store.toolCallStats()).toEqual([]);
});
