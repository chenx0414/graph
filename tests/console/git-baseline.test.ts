import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { GitIntegration, outOfScopePaths, rechecksAfterIntegrationChange } from '../../src/git/integration.ts';
import type { NodeSpec, Operation } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function makeProject(root: string, stateDir: string) {
  await mkdir(stateDir, { recursive: true });
  const db = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(async () => db.close());
  db.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
  return { db, integration: new GitIntegration(db, stateDir) };
}

async function temp(name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('baseline excludes the state dir, staged .env and generated paths (UC-S02)', async () => {
  const root = await temp('baseline');
  const state = join(root, '.graph-runtime');
  await writeFile(join(root, 'app.txt'), 'hello\n');
  await writeFile(join(root, '.env'), 'SECRET=synthetic\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.env']);
  const { integration } = await makeProject(root, state);
  const prep = integration.prepareProject('p', { createBaseline: true });
  expect(prep.state).toBe('ready');
  const tree = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
  expect(tree).toContain('app.txt');
  expect(tree).not.toContain('.env');
  expect(tree.some(path => path.includes('.graph-runtime'))).toBe(false);
  // The synthetic .env stays staged and on disk; Graph did not destroy it.
  expect(git(root, ['status', '--porcelain'])).toContain('.env');
  expect(existsSync(join(state, 'tasks.sqlite-wal')) || existsSync(join(state, 'tasks.sqlite'))).toBe(true);
  expect(await readFile(join(root, '.env'), 'utf8')).toContain('SECRET');
}, 30_000);

test('a selected subdirectory never commits sibling files (UC-S03)', async () => {
  const parent = await temp('subdir');
  const selected = join(parent, 'selected');
  await mkdir(selected);
  await writeFile(join(selected, 'app.txt'), 'selected\n');
  await writeFile(join(parent, 'sibling-private.txt'), 'sibling\n');
  git(parent, ['init', '-q', '-b', 'main']);
  git(parent, ['add', 'sibling-private.txt']);
  const { integration } = await makeProject(selected, join(parent, '.state'));
  expect(integration.prepareProject('p', { createBaseline: true }).state).toBe('ready');
  const tree = git(parent, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
  expect(tree).toContain('selected/app.txt');
  expect(tree).not.toContain('sibling-private.txt');
  expect(git(parent, ['status', '--porcelain'])).toContain('sibling-private.txt');
}, 30_000);

test('a linked worktree can create a scoped baseline (UC-R04)', async () => {
  const root = await temp('worktree');
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(join(root, 'app.txt'), 'base\n');
  git(root, ['add', 'app.txt']);
  git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '-m', 'init']);
  const linked = join(root, 'linked');
  git(root, ['worktree', 'add', '-q', linked]);
  await writeFile(join(linked, 'app.txt'), 'changed\n');
  const { integration } = await makeProject(linked, join(root, '.state'));
  const prep = integration.prepareProject('p', { createBaseline: true });
  expect(prep.state).toBe('ready');
  expect(git(linked, ['show', 'HEAD:app.txt'])).toBe('changed');
}, 30_000);

test('a stale ready snapshot no longer authorizes dispatch (UC-S01)', async () => {
  const root = await temp('stale');
  await writeFile(join(root, 'app.txt'), 'v1\n');
  await writeFile(join(root, 'other.txt'), 'keep\n');
  const { integration } = await makeProject(root, join(root, '.state'));
  expect(integration.prepareProject('p', { initialize: true, createBaseline: true }).state).toBe('ready');
  expect(integration.requirePrepared('p').baselineSha).toBeDefined();
  await writeFile(join(root, 'app.txt'), 'v2\n');
  expect(() => integration.requirePrepared('p')).toThrowError(/uncommitted changes/);
  // Explicit re-preparation captures the edit into the new baseline.
  const reprepared = integration.prepareProject('p', { createBaseline: true });
  expect(reprepared.state).toBe('ready');
  expect(git(root, ['show', 'HEAD:app.txt'])).toBe('v2');
  expect(integration.requirePrepared('p').baselineSha).toBe(git(root, ['rev-parse', 'HEAD']));
}, 30_000);

test('a user commit after ready is re-recorded instead of trusted blindly', async () => {
  const root = await temp('moved');
  await writeFile(join(root, 'app.txt'), 'v1\n');
  const { integration } = await makeProject(root, join(root, '.state'));
  const first = integration.prepareProject('p', { initialize: true, createBaseline: true });
  await writeFile(join(root, 'app.txt'), 'v2\n');
  git(root, ['add', 'app.txt']);
  git(root, ['-c', 'user.name=User', '-c', 'user.email=user@local', 'commit', '-q', '-m', 'user change']);
  const next = integration.requirePrepared('p');
  expect(next.state).toBe('ready');
  expect(next.baselineSha).not.toBe(first.baselineSha);
  expect(next.baselineSha).toBe(git(root, ['rev-parse', 'HEAD']));
  expect((next.detail as { fingerprint?: string }).fingerprint).toBeDefined();
}, 30_000);

test('every env credential variant is excluded, including staged ones (UC-S02-R1)', async () => {
  const root = await temp('env-variants');
  await writeFile(join(root, 'app.txt'), 'hello\n');
  await writeFile(join(root, '.env.production'), 'PROD=secret\n');
  await writeFile(join(root, '.env.staging'), 'STAGE=secret\n');
  await writeFile(join(root, '.env.example'), 'EXAMPLE=placeholder\n');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'config', '.env.ci'), 'CI=secret\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.env.production', 'config/.env.ci']);
  const { integration } = await makeProject(root, join(root, '.state'));
  expect(integration.prepareProject('p', { initialize: true, createBaseline: true }).state).toBe('ready');
  const tree = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
  expect(tree).toContain('app.txt');
  expect(tree).toContain('.env.example');
  expect(tree.some(path => path.includes('.env.production') || path.includes('.env.staging') || path.includes('.env.ci'))).toBe(false);
  // User credentials stay on disk and staged state is preserved.
  expect(await readFile(join(root, '.env.production'), 'utf8')).toContain('PROD=secret');
  expect(git(root, ['status', '--porcelain'])).toContain('.env.production');
}, 30_000);

test('deleting files in a selected subdirectory never changes sibling trees (UC-S03-R1)', async () => {
  const parent = await temp('subdir-delete');
  const selected = join(parent, 'selected');
  await mkdir(selected);
  await writeFile(join(selected, 'app.txt'), 'selected\n');
  await writeFile(join(selected, 'other.txt'), 'other\n');
  await writeFile(join(parent, 'sibling.txt'), 'sibling\n');
  git(parent, ['init', '-q', '-b', 'main']);
  git(parent, ['add', '-A']);
  git(parent, ['-c', 'user.name=G', '-c', 'user.email=g@l', 'commit', '-q', '-m', 'init']);
  const { integration } = await makeProject(selected, join(parent, '.state'));

  // Removal is already staged through git rm: the parent tree must survive.
  git(parent, ['rm', '-q', 'selected/app.txt']);
  expect(integration.prepareProject('p', { createBaseline: true }).state).toBe('ready');
  let tree = git(parent, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
  expect(tree).toContain('sibling.txt');
  expect(tree).toContain('selected/other.txt');
  expect(tree).not.toContain('selected/app.txt');

  // Unstaged deletion of the last file in scope: same rule, no empty tree.
  const headBefore = git(parent, ['rev-parse', 'HEAD']);
  await rm(join(selected, 'other.txt'));
  expect(integration.prepareProject('p', { createBaseline: true }).state).toBe('ready');
  tree = git(parent, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
  expect(tree).toContain('sibling.txt');
  expect(tree).not.toContain('selected/other.txt');
  expect(git(parent, ['rev-parse', 'HEAD'])).not.toBe(headBefore);
  expect(existsSync(join(parent, 'sibling.txt'))).toBe(true);

  // With nothing to commit in scope, HEAD does not move and no empty tree lands.
  const settled = git(parent, ['rev-parse', 'HEAD']);
  expect(integration.prepareProject('p', { createBaseline: true }).state).toBe('ready');
  expect(git(parent, ['rev-parse', 'HEAD'])).toBe(settled);
}, 30_000);

test('a judging node re-reads the current integration instead of its stale work copy', async () => {
  const root = await temp('reseed');
  const state = join(root, '.state');
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(join(root, 'app.txt'), 'base\n');
  git(root, ['add', 'app.txt']);
  git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '-m', 'init']);
  const { db, integration } = await makeProject(root, state);
  expect(integration.prepareProject('p', { createBaseline: true }).state).toBe('ready');
  db.db.prepare("INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES('t','p','审查看板四态',1,0,'running',0,1)").run();
  integration.prepareTask('t', 'main');

  // The review work copy is seeded from the integration tip of its first run.
  const first = integration.workspace('t', 'inst-review', 'review', 'agent', 'review');
  expect(first).toBeTruthy();
  expect(git(first!, ['rev-parse', 'HEAD'])).toBe(git(root, ['rev-parse', 'HEAD']));

  // A reworked lane advances the integration tip; a judging node must read the new tree, not the
  // one it was first seeded with (reusing the old tree made reviews restate stale findings).
  await writeFile(join(root, 'lane.txt'), 'reworked\n');
  git(root, ['add', 'lane.txt']);
  git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '-m', 'lane rework']);
  const tip = git(root, ['rev-parse', 'HEAD']);
  db.db.prepare('UPDATE tasks SET integration_sha=? WHERE id=?').run(tip, 't');
  const again = integration.workspace('t', 'inst-review', 'review', 'agent', 'review');
  expect(git(again!, ['rev-parse', 'HEAD'])).toBe(tip);
  expect(existsSync(join(again!, 'lane.txt'))).toBe(true);

  // A work lane is deliberately left alone: its own commits survive a retry.
  const lane = integration.workspace('t', 'inst-lane', 'impl-x', 'agent', 'work');
  expect(lane).toBeTruthy();
  await writeFile(join(lane!, 'own.txt'), 'lane work in progress\n');
  git(lane!, ['add', 'own.txt']);
  git(lane!, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '-m', 'lane own commit']);
  const laneAgain = integration.workspace('t', 'inst-lane', 'impl-x', 'agent', 'work');
  expect(existsSync(join(laneAgain!, 'own.txt'))).toBe(true);
}, 30_000);

test('only program checks and judging agent nodes re-run when the integration moves', () => {
  const spec = (kind: string, action: string) => ({ kind, action } as unknown as NodeSpec);
  expect(rechecksAfterIntegrationChange(spec('program', 'graph.command'), 'succeeded')).toBe(true);
  // A review read the integration sha it judged; after a lane rework its verdict is about old code.
  expect(rechecksAfterIntegrationChange(spec('agent', 'review'), 'succeeded')).toBe(true);
  // A work lane keeps its own commits, and a node that never finished has nothing to invalidate.
  expect(rechecksAfterIntegrationChange(spec('agent', 'work'), 'succeeded')).toBe(false);
  expect(rechecksAfterIntegrationChange(spec('program', 'graph.command'), 'running')).toBe(false);
  expect(rechecksAfterIntegrationChange(spec('program', 'graph.command'), 'blocked')).toBe(false);
});

test('a terminal task releases its working copies but keeps its integration branch', async () => {
  const root = await temp('release');
  const state = join(root, '.state');
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(join(root, 'app.txt'), 'base\n');
  git(root, ['add', 'app.txt']);
  git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '-m', 'init']);
  const { db, integration } = await makeProject(root, state);
  expect(integration.prepareProject('p', { createBaseline: true }).state).toBe('ready');
  db.db.prepare("INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES('t','p','清理工作副本',1,0,'running',0,1)").run();
  integration.prepareTask('t', 'main');
  expect(integration.workspace('t', 'inst-work', 'impl-x', 'agent', 'work')).toBeTruthy();
  const rows = db.db.prepare('SELECT instance_id,path,branch FROM worktrees WHERE task_id=?').all('t') as { instance_id: string; path: string; branch: string }[];
  expect(rows.length).toBeGreaterThan(1);
  const taskBranch = rows.find(row => row.instance_id.startsWith('integration:'))!.branch;
  const copyBranches = rows.map(row => row.branch).filter(branch => branch.startsWith('graph/copy/'));
  expect(copyBranches.length).toBeGreaterThan(0);
  for (const row of rows) expect(existsSync(row.path)).toBe(true);

  db.db.prepare("UPDATE tasks SET phase='completed' WHERE id='t'").run();
  expect(integration.sweepTerminalWorkcopies()).toBe(1);

  for (const row of rows) expect(existsSync(row.path)).toBe(false);
  expect(db.db.prepare('SELECT COUNT(*) AS n FROM worktrees WHERE task_id=?').get('t')).toEqual({ n: 0 });
  for (const branch of copyBranches) {
    expect(() => git(root, ['rev-parse', '--verify', '--quiet', branch])).toThrow();
  }
  expect(git(root, ['rev-parse', '--verify', '--quiet', taskBranch])).toBeTruthy();
  // A running task keeps its copies: only terminal phases are swept.
  db.db.prepare("UPDATE tasks SET phase='running' WHERE id='t'").run();
  expect(integration.sweepTerminalWorkcopies()).toBe(0);
}, 30_000);

test('an identical tree keeps the acceptance while a content change re-checks it', async () => {
  const root = await temp('retarget');
  const state = join(root, '.state');
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(join(root, 'app.txt'), 'base\n');
  git(root, ['add', 'app.txt']);
  git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '-m', 'init']);
  const { db, integration } = await makeProject(root, state);
  expect(integration.prepareProject('p', { createBaseline: true }).state).toBe('ready');
  db.db.prepare("INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES('t','p','同树前进',1,0,'running',0,1)").run();
  integration.prepareTask('t', 'main');
  const accepted = git(root, ['rev-parse', 'HEAD']);
  // The fixture writes an evidence row directly; its operation reference has no matching row in this
  // throwaway database, so foreign keys are off for this test only.
  db.db.exec('PRAGMA foreign_keys = OFF');
  db.db.prepare("INSERT INTO evidence(id,task_id,node_id,operation_id,acceptance_id,proposal_version,requirement_version,data,commit_sha,valid) VALUES('e','t','human-accept','op','acceptance',1,1,'{}',?,1)").run(accepted);

  // A commit that does not change the tree: the acceptance still describes the current content, so
  // the evidence is re-bound instead of forcing the user through the same acceptance again.
  git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '--allow-empty', '-m', 'delivery fast-forward']);
  const identical = git(root, ['rev-parse', 'HEAD']);
  expect(integration.retargetEvidence('t', accepted, identical)).toBe(true);
  expect(db.db.prepare("SELECT commit_sha FROM evidence WHERE id='e'").get()).toEqual({ commit_sha: identical });
  const rebound = db.db.prepare("SELECT data FROM events WHERE task_id='t' AND type='git.evidence.retargeted'").get() as { data: string };
  expect(rebound.data).toContain(identical);

  // A real content change must still invalidate the acceptance.
  await writeFile(join(root, 'app.txt'), 'changed\n');
  git(root, ['add', 'app.txt']);
  git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '-m', 'content change']);
  const changed = git(root, ['rev-parse', 'HEAD']);
  expect(integration.retargetEvidence('t', identical, changed)).toBe(false);
  expect(db.db.prepare("SELECT commit_sha FROM evidence WHERE id='e'").get()).toEqual({ commit_sha: identical });
}, 30_000);

test('a lane that carries a sibling lane file is restored to its own scope before merging', async () => {
  // A file scope may name a file or a directory prefix; everything else belongs to a sibling lane,
  // except the node's own evidence directory, which is its submission material.
  expect(outOfScopePaths(['src/a.txt', 'src/b.txt', 'docs/x.md'], ['src/a.txt'])).toEqual(['src/b.txt', 'docs/x.md']);
  expect(outOfScopePaths(['src/a/x.ts', 'src/ab/x.ts'], ['src/a/'])).toEqual(['src/ab/x.ts']);
  expect(outOfScopePaths(['evidence/shot.png', 'src/b.txt'], ['src/a.txt'])).toEqual(['src/b.txt']);

  const root = await temp('scope');
  const state = join(root, '.state');
  git(root, ['init', '-q', '-b', 'main']);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.txt'), 'a\n');
  await writeFile(join(root, 'src', 'b.txt'), 'b\n');
  git(root, ['add', 'src']);
  git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '-m', 'init']);
  const { db, integration } = await makeProject(root, state);
  expect(integration.prepareProject('p', { createBaseline: true }).state).toBe('ready');
  db.db.prepare("INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES('t','p','车道越界',1,0,'running',0,1)").run();
  integration.prepareTask('t', 'main');
  for (const [id, file] of [['impl-a', 'src/a.txt'], ['impl-b', 'src/b.txt']] as const) {
    db.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)')
      .run('t', id, JSON.stringify({ id, kind: 'agent', action: 'work', input: { files: [file] } }), `inst-${id}`);
  }
  const lane = integration.workspace('t', 'inst-impl-a', 'impl-a', 'agent', 'work')!;
  // The lane edits its own file and, by mistake, the sibling's.
  await writeFile(join(lane, 'src', 'a.txt'), 'a fixed\n');
  await writeFile(join(lane, 'src', 'b.txt'), 'b rewritten by the wrong lane\n');
  const operation = { id: 'op-a', taskId: 't', instanceId: 'inst-impl-a', nodeId: 'impl-a', kind: 'agent' } as unknown as Operation;
  expect(integration.integrate(operation)).toMatchObject({ ok: true });
  const integrationPath = (db.db.prepare("SELECT path FROM worktrees WHERE instance_id='integration:t'").get() as { path: string }).path;
  // The lane's own work landed; the sibling file never did, and the recovery is recorded.
  expect(git(integrationPath, ['show', 'HEAD:src/a.txt'])).toBe('a fixed');
  expect(git(integrationPath, ['show', 'HEAD:src/b.txt'])).toBe('b');
  const event = db.db.prepare("SELECT data FROM events WHERE task_id='t' AND type='git.out-of-scope.restored'").get() as { data: string } | undefined;
  expect(event?.data).toContain('src/b.txt');
  // A file the lane created outside its scope is reported, never deleted.
  await writeFile(join(lane, 'src', 'created-by-lane.txt'), 'new\n');
  expect(integration.integrate({ ...operation, id: 'op-b' } as unknown as Operation)).toMatchObject({ ok: true });
  expect(existsSync(join(lane, 'src', 'created-by-lane.txt'))).toBe(true);
  const reported = db.db.prepare("SELECT data FROM events WHERE task_id='t' AND type='git.out-of-scope.restored' ORDER BY rowid DESC LIMIT 1").get() as { data: string };
  expect(reported.data).toContain('created-by-lane.txt');
}, 30_000);
