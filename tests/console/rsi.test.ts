import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { git as runGit } from '../../src/git/git.ts';
import { graphApplicationRoot } from '../../src/runtime/graph-root.ts';
import { RsiService, resolveRsiRoot, type RsiValidationResult } from '../../src/runtime/rsi.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function shell(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-rsi-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  shell(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'graph', scripts: { check: 'true' } }, null, 2));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.ts'), 'export const value = 1;\n');
  shell(root, ['add', '-A']);
  shell(root, ['commit', '-m', 'init']);
  return root;
}

/** A real ledger with one project, conversation and anchor task. */
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-rsi-state-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStore(join(dir, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const taskId = 'task-rsi';
  const conversationId = 'conversation-rsi';
  const now = Date.now();
  store.db.prepare('INSERT INTO projects VALUES(?,?,?)').run('p', '/tmp/p', '[]');
  store.db.prepare('INSERT INTO tasks(id,project_id,request,created_seq,conversation_id) VALUES(?,?,?,?,?)')
    .run(taskId, 'p', 'improve graph', 1, conversationId);
  store.db.prepare(`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,binding_since_seq)
    VALUES(?,?,?,?,?,?,?,?)`).run(conversationId, 'p', 'p', taskId, 'rsi', 1, now, 1);
  return { store, taskId, conversationId, dir };
}

const passing = async (): Promise<RsiValidationResult[]> => [{ command: 'mock check', status: 'passed', output: '' }];

function service(root: string, stateDir: string, validate = passing) {
  return new RsiService({ root, stateDir, validate });
}

test('status reports an available checkout and its branch', async () => {
  const root = await repo();
  const real = await realpath(root);
  const { dir } = ledger();
  const status = await service(root, dir).status();
  expect(status.available).toBe(true);
  expect(status.root).toBe(real);
  expect(status.branch).toBe('main');
  expect(status.pendingRestart).toBeNull();
});

test('status reports unavailable when the root is not a Graph checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graph-rsi-empty-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const status = await new RsiService({ root: dir, stateDir: dir, validate: passing }).status();
  expect(status.available).toBe(false);
  expect(status.pendingRestart).toBeNull();
});

test('apply writes files, commits to an rsi branch and schedules a reload', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const receipt = await rsi.apply({
    title: 'Add a helper',
    problem: 'A repeated helper is missing.',
    changes: [{ path: 'src/helper.ts', action: 'write', content: 'export const helper = () => 1;\n' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect(receipt.branch).toMatch(/^rsi\//);
  expect(receipt.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(receipt.files).toEqual(['src/helper.ts']);
  expect(receipt.restartRequired).toBe(true);
  expect(await readFile(join(root, 'src', 'helper.ts'), 'utf8')).toContain('helper');
  expect(shell(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toMatch(/^rsi\//);
  expect(shell(root, ['log', '-1', '--format=%s'])).toBe('rsi: Add a helper');
  const restart = JSON.parse(await readFile(join(dir, 'rsi', 'restart.json'), 'utf8')) as { id: string; commit: string };
  expect(restart.id).toBe(receipt.id);
  expect(restart.commit).toBe(receipt.commit);
  // The change is reported to the user as a durable conversation message.
  const message = store.db.prepare('SELECT role,kind,data FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1').get(conversationId) as { role: string; kind: string; data: string };
  expect(message.role).toBe('system');
  expect(message.kind).toBe('rsi');
  expect((JSON.parse(message.data) as { status: string }).status).toBe('applied');
  expect((store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='rsi.change'").get() as { count: number }).count).toBe(1);
});

test('apply replaces exactly once and refuses ambiguous edits', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const applied = await rsi.apply({
    title: 'Bump value',
    problem: 'Value should be two.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'value = 1', newText: 'value = 2' }] }],
  }, { store, taskId, conversationId });
  expect(applied.status).toBe('applied');
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 2');

  const ambiguous = await rsi.apply({
    title: 'Bad edit',
    problem: 'Missing text.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'does-not-exist', newText: 'x' }] }],
  }, { store, taskId, conversationId });
  expect(ambiguous.status).toBe('rolled_back');
  expect(ambiguous.error).toContain('exactly once');
});

test('apply deletes a file and rejects path escape and .git targets', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const deleted = await rsi.apply({
    title: 'Drop keep',
    problem: 'Unused.',
    changes: [{ path: 'src/keep.ts', action: 'delete' }],
  }, { store, taskId, conversationId });
  expect(deleted.status).toBe('applied');
  expect(existsSync(join(root, 'src', 'keep.ts'))).toBe(false);

  await expect(rsi.apply({
    title: 'Escape',
    problem: 'Nope.',
    changes: [{ path: '../escape.ts', action: 'write', content: 'x' }],
  }, { store, taskId, conversationId })).rejects.toThrow(/inside the Graph source root/);

  await expect(rsi.apply({
    title: 'Git metadata',
    problem: 'Nope.',
    changes: [{ path: '.git/config', action: 'write', content: 'x' }],
  }, { store, taskId, conversationId })).rejects.toThrow(/inside the Graph source root/);
});

test('apply refuses a target file with uncommitted changes', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  await writeFile(join(root, 'src', 'keep.ts'), 'export const value = 9;\n');
  await expect(service(root, dir).apply({
    title: 'Conflict',
    problem: 'Dirty target.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 3;\n' }],
  }, { store, taskId, conversationId })).rejects.toThrow(/uncommitted changes/);
});

test('a failed check keeps the change so the Agent can keep fixing', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  let fails = true;
  const flaky = async (): Promise<RsiValidationResult[]> => [
    { command: 'mock check', status: fails ? 'failed' : 'passed', output: fails ? 'boom' : '' },
  ];
  const rsi = service(root, dir, flaky);
  const failed = await rsi.apply({
    title: 'Broken change',
    problem: 'Introduce a regression.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 42;\n' }],
  }, { store, taskId, conversationId });
  expect(failed.status).toBe('checks_failed');
  expect(failed.pendingFiles).toEqual(['src/keep.ts']);
  // The change survives on disk and is not committed.
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 42');
  expect(shell(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toMatch(/^rsi\//);
  expect(shell(root, ['log', '-1', '--format=%s'])).toBe('init');
  expect(existsSync(join(dir, 'rsi', 'restart.json'))).toBe(false);
  expect(existsSync(join(dir, 'rsi', 'working.json'))).toBe(true);

  // The same file can be edited again because the failed attempt owns it.
  fails = false;
  const fixed = await rsi.apply({
    title: 'Fix the regression',
    problem: 'Correct the earlier attempt.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'value = 42', newText: 'value = 7' }] }],
  }, { store, taskId, conversationId });
  expect(fixed.status).toBe('applied');
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 7');
  expect(shell(root, ['log', '-1', '--format=%s'])).toBe('rsi: Fix the regression');
  expect(existsSync(join(dir, 'rsi', 'working.json'))).toBe(false);

  // A flaky failure can be retried without changing files.
  fails = true;
  const retry = await rsi.apply({
    title: 'Retry checks',
    problem: 'Check was flaky.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 8;\n' }],
  }, { store, taskId, conversationId });
  expect(retry.status).toBe('checks_failed');
  fails = false;
  const rerun = await rsi.apply({
    title: 'Retry checks',
    problem: 'Check was flaky.',
    changes: [],
  }, { store, taskId, conversationId });
  expect(rerun.status).toBe('applied');
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 8');
  expect(shell(root, ['log', '-1', '--format=%s'])).toBe('rsi: Retry checks');
});

test('activate=false commits without scheduling a reload', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const receipt = await service(root, dir).apply({
    title: 'Docs only',
    problem: 'Documentation gap.',
    activate: false,
    changes: [{ path: 'docs/note.md', action: 'write', content: '# note\n' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect(receipt.restartRequired).toBe(false);
  expect(existsSync(join(dir, 'rsi', 'restart.json'))).toBe(false);
});

test('an unavailable root is reported to the user instead of thrown', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'graph-rsi-state-'));
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const { store, taskId, conversationId } = ledger();
  const receipt = await new RsiService({ stateDir, validate: passing }).apply({
    title: 'No checkout',
    problem: 'Nothing to change.',
    changes: [{ path: 'a.ts', action: 'write', content: 'x' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('unavailable');
  expect(receipt.report).toContain('RSI 不可用');
  expect((await new RsiService({ stateDir, validate: passing }).status()).reason).toContain('GRAPH_RSI_ROOT');
});

test('ackRestart clears only the matching request id', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const receipt = await rsi.apply({
    title: 'Pending',
    problem: 'Needs a reload.',
    changes: [{ path: 'src/one.ts', action: 'write', content: '1\n' }],
  }, { store, taskId, conversationId });
  expect((await rsi.status()).pendingRestart?.id).toBe(receipt.id);
  expect((await rsi.ackRestart('other')).cleared).toBe(false);
  expect((await rsi.ackRestart(receipt.id)).cleared).toBe(true);
  expect((await rsi.status()).pendingRestart).toBeNull();
  expect(existsSync(join(dir, 'rsi', 'restart.json'))).toBe(false);
});

test('resolveRsiRoot prefers an explicit GRAPH_RSI_ROOT', async () => {
  const root = await repo();
  const real = await realpath(root);
  expect(resolveRsiRoot({ GRAPH_RSI_ROOT: root }, '/nowhere')).toBe(real);
  expect(resolveRsiRoot({}, root)).toBe(real);
  // With no usable cwd it falls back to the running Graph checkout.
  expect(resolveRsiRoot({}, '/nowhere')).toBe(await realpath(graphApplicationRoot()));
});

test('status counts running operations so a reload can wait', async () => {
  const root = await repo();
  const { store, taskId, dir } = ledger();
  store.db.prepare('INSERT INTO nodes(task_id,id,spec,status) VALUES(?,?,?,?)').run(taskId, 'master', '{}', 'running');
  store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active)
    VALUES(?,?,?,?,?,?,?,?)`).run('op1', taskId, 'master', 0, '{}', 'dispatched', 0, 0);
  const status = await service(root, dir).status();
  expect(status.activeOperations).toBe(1);
  expect(status.canRestart).toBe(false);
});

test('a forced change reloads even with operations still running', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  store.db.prepare('INSERT INTO nodes(task_id,id,spec,status) VALUES(?,?,?,?)').run(taskId, 'master', '{}', 'running');
  store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active)
    VALUES(?,?,?,?,?,?,?,?)`).run('op1', taskId, 'master', 0, '{}', 'dispatched', 0, 0);
  const rsi = service(root, dir);
  const receipt = await rsi.apply({
    title: 'Force the reload',
    problem: 'Must go live now.',
    force: true,
    changes: [{ path: 'src/forced.ts', action: 'write', content: 'export const forced = true;\n' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect(receipt.force).toBe(true);
  const restart = JSON.parse(await readFile(join(dir, 'rsi', 'restart.json'), 'utf8')) as { force: boolean };
  expect(restart.force).toBe(true);
  const status = await rsi.status();
  expect(status.activeOperations).toBe(1);
  expect(status.canRestart).toBe(true);
});

test('a large file is accepted because only the report is bounded', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const content = `export const blob = '${'x'.repeat(3 * 1024 * 1024)}';\n`;
  const receipt = await service(root, dir).apply({
    title: 'Add a large file',
    problem: 'The file is genuinely large.',
    changes: [{ path: 'src/blob.ts', action: 'write', content }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect((await stat(join(root, 'src', 'blob.ts'))).size).toBeGreaterThan(3 * 1024 * 1024);
  // The report diff is truncated, but the file itself is intact.
  expect(receipt.diff?.length ?? 0).toBeLessThanOrEqual(40_000 + 200);
});

test('custom checks give a fast inner loop without running the full gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-rsi-checks-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  shell(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'graph', scripts: { check: 'node -e "process.exit(1)"', ok: 'node -e "process.exit(0)"' },
  }, null, 2));
  shell(root, ['add', '-A']);
  shell(root, ['commit', '-m', 'init']);
  const { store, taskId, conversationId, dir } = ledger();
  // No mock validate: this exercises the real default check ladder.
  const rsi = new RsiService({ root, stateDir: dir });
  const fast = await rsi.apply({
    title: 'Fast inner loop',
    problem: 'Iterate quickly.',
    activate: false,
    changes: [{ path: 'note.md', action: 'write', content: 'hello\n' }],
    checks: [{ command: 'node', args: ['--run', 'ok'] }],
  }, { store, taskId, conversationId });
  expect(fast.status).toBe('applied');
  expect(fast.validation.map(item => item.command)).toEqual(['node --run ok']);

  // Without a custom check the full gate runs and fails.
  const gated = await rsi.apply({
    title: 'Full gate',
    problem: 'The repo check is broken.',
    activate: false,
    changes: [{ path: 'note2.md', action: 'write', content: 'hello\n' }],
  }, { store, taskId, conversationId });
  expect(gated.status).toBe('checks_failed');
  expect(gated.validation.map(item => item.command)).toEqual(['node --run check']);
});
