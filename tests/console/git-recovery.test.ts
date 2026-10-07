import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { canonicalJson, TaskStore } from '../../src/core/store.ts';
import { GitIntegration } from '../../src/git/integration.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-recovery-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'app.txt'), 'v0\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['add', 'app.txt']);
  git(project, ['-c', 'user.name=G', '-c', 'user.email=g@l', 'commit', '-q', '-m', 'init']);
  await writeFile(join(project, 'app.txt'), 'v1\n');
  const stateDir = join(root, 'state');
  return { root, project, stateDir, initial: git(project, ['rev-parse', 'HEAD']) };
}

const open = (stateDir: string, project: string) => openTaskRuntime({ stateDir, projects: [{ id: 'p', root: project }], actions: {} });

function insertIntent(stateDir: string, spec: unknown) {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(stateDir, { recursive: true });
  const db = new TaskStore(join(stateDir, 'tasks.sqlite'));
  db.db.prepare('INSERT INTO git_ops VALUES(?,?,?,?,?,?)').run('intent-crash', 'project:p', 'prepare', 'intent', canonicalJson(spec), null);
  db.close();
}

test('crash after the baseline commit never commits later user edits (UC-S04-R1)', async () => {
  const { project, stateDir, initial } = await fixture('after');
  const runtime1 = await open(stateDir, project);
  await runtime1.projects.prepare({ projectId: 'p', requestId: 'r1', initialize: true, createBaseline: true });
  const baseline = git(project, ['rev-parse', 'HEAD']);
  expect(baseline).not.toBe(initial);
  await runtime1.close();

  // User edits after the interrupted request: recovery must not commit them.
  await writeFile(join(project, 'app.txt'), 'v2-user\n');
  insertIntent(stateDir, { payload: { type: 'prepare', projectId: 'p', initialize: true, createBaseline: true }, requestId: 'crash-1', headBefore: initial, fingerprintBefore: 'stale' });

  const runtime2 = await open(stateDir, project);
  cleanup.push(() => runtime2.close());
  expect(git(project, ['rev-list', '--count', 'HEAD'])).toBe('2');
  expect(git(project, ['rev-parse', 'HEAD'])).toBe(baseline);
  expect(git(project, ['show', 'HEAD:app.txt'])).toBe('v1');
  expect(git(project, ['status', '--porcelain'])).toContain('app.txt');

  const db = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const op = db.db.prepare("SELECT state,result FROM git_ops WHERE id='intent-crash'").get() as { state: string; result: string };
  expect(op.state).toBe('succeeded');
  expect(JSON.parse(op.result)).toMatchObject({ alreadyApplied: true });
  const command = db.db.prepare("SELECT receipt FROM commands WHERE scope='projects' AND request_id='crash-1'").get() as { receipt: string } | undefined;
  expect(command).toBeDefined();
  const preparation = db.db.prepare("SELECT state FROM project_preparation WHERE project_id='p'").get() as { state: string };
  expect(preparation.state).toBe('detected');
  db.close();
}, 60_000);

test('crash before the commit with a changed worktree is unresolved, not replayed (UC-S04-R1)', async () => {
  const { project, stateDir, initial } = await fixture('before');
  await writeFile(join(project, 'app.txt'), 'draft\n');
  insertIntent(stateDir, { payload: { type: 'prepare', projectId: 'p', initialize: true, createBaseline: true }, requestId: 'crash-2', headBefore: initial, fingerprintBefore: 'does-not-match' });
  const runtime = await open(stateDir, project);
  cleanup.push(() => runtime.close());
  expect(git(project, ['rev-list', '--count', 'HEAD'])).toBe('1');
  const db = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const op = db.db.prepare("SELECT state,result FROM git_ops WHERE id='intent-crash'").get() as { state: string; result: string };
  expect(op.state).toBe('unresolved');
  expect(JSON.parse(op.result).reason).toMatch(/changed/);
  const preparation = db.db.prepare("SELECT state,detail FROM project_preparation WHERE project_id='p'").get() as { state: string; detail: string };
  expect(preparation.state).toBe('failed');
  db.close();
}, 60_000);

test('crash before the commit with an unchanged worktree replays exactly once (UC-S04-R1)', async () => {
  const { project, stateDir, initial } = await fixture('replay');
  await writeFile(join(project, 'app.txt'), 'authorized\n');
  const before = await import('../../src/git/git.ts');
  const fingerprint = before.repoFingerprint(project, { subdir: '' });
  insertIntent(stateDir, { payload: { type: 'prepare', projectId: 'p', initialize: true, createBaseline: true }, requestId: 'crash-3', headBefore: initial, fingerprintBefore: fingerprint });
  const runtime = await open(stateDir, project);
  cleanup.push(() => runtime.close());
  expect(git(project, ['rev-list', '--count', 'HEAD'])).toBe('2');
  expect(git(project, ['show', 'HEAD:app.txt'])).toBe('authorized');
  const db = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const op = db.db.prepare("SELECT state,result FROM git_ops WHERE id='intent-crash'").get() as { state: string; result: string };
  expect(op.state).toBe('succeeded');
  expect(JSON.parse(op.result)).toMatchObject({ reconciled: true });
  db.close();
}, 60_000);

test('a plain-directory intent without usable evidence is unresolved, never replayed (UC-S04-R2)', async () => {
  const root = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'graph-recovery-plain-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await (await import('node:fs/promises')).mkdir(project, { recursive: true });
  await writeFile(join(project, 'app.txt'), 'authorized\n');
  const stateDir = join(root, 'state');
  // Old-style intent: no head and no directory fingerprint (null == null must
  // not be accepted as proof that the selected files are unchanged).
  insertIntent(stateDir, { payload: { type: 'prepare', projectId: 'p', initialize: true, createBaseline: true }, requestId: 'crash-plain', headBefore: null, fingerprintBefore: null });
  await writeFile(join(project, 'app.txt'), 'new unapproved content after crash\n');
  const runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'p', root: project }], actions: {} });
  cleanup.push(() => runtime.close());
  expect(existsSync(join(project, '.git'))).toBe(false);
  const db = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const op = db.db.prepare("SELECT state,result FROM git_ops WHERE id='intent-crash'").get() as { state: string; result: string };
  expect(op.state).toBe('unresolved');
  expect(JSON.parse(op.result).reason).toMatch(/changed|attributed/);
  db.close();
}, 60_000);


test('rework restores a released integration checkout at its recorded tip without including later user edits', async () => {
  const { project, stateDir } = await fixture('rework');
  const runtime = await open(stateDir, project);
  cleanup.push(() => runtime.close());
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'rework', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'rework',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: 'Restored integration', protocols: { data: { type: 'object' } }, nodes: {},
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } }, edges: {},
      acceptance: [{ id: 'ok', description: 'ok', kind: 'check', module: 'check' }] }),
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const integration = new GitIntegration(store, stateDir);
  const original = integration.workspace(taskId, null, 'check', 'program')!;
  const tip = git(original, ['rev-parse', 'HEAD']);
  store.db.prepare("UPDATE tasks SET phase='completed' WHERE id=?").run(taskId);
  integration.sweepTerminalWorkcopies();
  expect(existsSync(original)).toBe(false);
  await writeFile(join(project, 'app.txt'), 'later user edit');
  store.db.prepare("UPDATE tasks SET phase='running' WHERE id=?").run(taskId);
  const restored = integration.workspace(taskId, null, 'check', 'program')!;
  expect(git(restored, ['rev-parse', 'HEAD'])).toBe(tip);
  expect(git(restored, ['status', '--porcelain'])).toBe('');
  expect(git(project, ['status', '--porcelain'])).toContain('app.txt');
  expect(integration.workspace(taskId, null, 'check', 'program')).toBe(restored);
}, 30_000);
