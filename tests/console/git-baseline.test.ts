import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { GitIntegration } from '../../src/git/integration.ts';
import { nativeGitConflict } from '../fixtures/native-git-conflict.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

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

// Exact commit receipts replace dependency-closure guesses. Git can update integration,
// but only an explicit module input authorizes another check execution.
test.each(['owned-file', 'unrelated-file', 'directory', 'deletion', 'empty-commit', 'unchanged'] as const)(
  'native acceptance retains its exact check receipt when the target advances: %s', async change => {
    await nativeTargetAdvance(change);
  }, 30000);

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

test('a target already containing the verified commit preserves dirty files without rewriting the checkout', async () => {
  await nativeTargetAdvance('dirty');
}, 30000);

async function nativeTargetAdvance(change: 'owned-file' | 'unrelated-file' | 'directory' | 'deletion' | 'empty-commit' | 'unchanged' | 'dirty') {
  const root = await temp('native-target'); const stateDir = join(root, '.state');
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(join(root, 'app.txt'), 'base\n');
  await writeFile(join(root, 'check.cjs'), "if(require('fs').readFileSync('app.txt','utf8')!=='base\\n')process.exit(1)");
  git(root, ['add', 'app.txt', 'check.cjs']);
  const commit = (message: string) => git(root, ['-c', 'user.name=Graph', '-c', 'user.email=graph@local', 'commit', '-q', '--allow-empty', '-m', message]);
  commit('baseline'); const baseline = git(root, ['rev-parse', 'HEAD']);
  const capabilityRoot = join(stateDir, 'capabilities'); await mkdir(capabilityRoot, { recursive: true });
  const runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'p', root }], catalog: { capabilityRoot, recipesPath: join(stateDir, 'recipes.json') } });
  cleanup.push(() => runtime.close());
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const parent = await runtime.user.begin({ projectId: 'p', request: 'Verify the exact integration version', requestId: 'begin' });
  const main = runtime.supervisor(parent.taskId); const data = { protocol: 'data' };
  const { graphId } = await main.graphCreate({ targetBranch: 'main', definition: parseGraphDefinition({ schemaVersion: 2, name: 'Exact receipt', protocols: { data: { type: 'object' } }, nodes: {},
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.cjs'], output: 'result' } } }, edges: {},
    acceptance: [{ id: 'works', description: 'The current integrated application contains the expected bytes', kind: 'check', module: 'check' }] }) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
  const inspect = () => main.graphInspect({ graphId, query: 'acceptance' }) as Promise<{ items: { id: string; status: string; source: { id: string; commit?: string } }[] }>;
  const prior = (await inspect()).items.find(item => item.id === 'works')!;
  expect(prior, JSON.stringify(runtime.events(graphId).filter(event => event.type.includes('operation') || event.type.includes('failed')))).toMatchObject({ status: 'passed', source: { commit: baseline } });
  const disk = new TaskStore(join(stateDir, 'tasks.sqlite')); cleanup.push(async () => disk.close());
  const integration = new GitIntegration(disk, stateDir);
  if (change === 'owned-file' || change === 'dirty') await writeFile(join(root, 'app.txt'), 'changed\n');
  if (change === 'unrelated-file') await writeFile(join(root, 'other.txt'), 'unrelated\n');
  if (change === 'directory') { await mkdir(join(root, 'nested')); await writeFile(join(root, 'nested', 'item.txt'), 'nested\n'); }
  if (change === 'deletion') await rm(join(root, 'app.txt'));
  if (!['dirty', 'unchanged'].includes(change)) { git(root, ['add', '-u']); if (change === 'unrelated-file') git(root, ['add', 'other.txt']); if (change === 'directory') git(root, ['add', 'nested']); commit(change); }
  const target = git(root, ['rev-parse', 'HEAD']);
  const delivered = integration.tryDeliver(graphId, baseline);
  expect(delivered.status).toBe(change === 'dirty' ? 'merged' : change === 'unchanged' ? 'merged' : 'recheck');
  // No delivery is necessary when target already names the verified commit. Dirty bytes stay intact.
  if (change === 'dirty') expect(await readFile(join(root, 'app.txt'), 'utf8')).toBe('changed\n');
  const now = (await inspect()).items.find(item => item.id === 'works')!;
  expect(now.status).toBe(['dirty', 'unchanged'].includes(change) ? 'passed' : 'stale');
  expect(now.source.id).toBe(prior.source.id);
  const receipt = disk.db.prepare('SELECT request,result FROM kernel_module_operations WHERE id=?').get(prior.source.id) as { request: string; result: string };
  expect(JSON.parse(receipt.result).outputs.result.verifiedCommit).toBe(baseline);
  expect(disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations WHERE task_id=?').get(graphId)).toEqual({ n: 1 });
  expect(disk.task(graphId).integration_sha).toBe(target);
  if (!['dirty', 'unchanged'].includes(change)) {
    await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
    const updated = (await inspect()).items.find(item => item.id === 'works')!;
    expect(updated.source.id).not.toBe(prior.source.id);
    expect(updated.status).toBe(['owned-file', 'deletion'].includes(change) ? 'failed' : 'passed');
    if (updated.status === 'passed') expect(updated.source.commit).toBe(target);
  }
}

test('a native code publication cannot commit a sibling worktree through the current node binding', async () => {
  const graph = await nativeGitConflict(cleanup);
  await writeFile(join(graph.trees.b, 'other.txt'), 'sibling private edit\n');
  const first = git(graph.trees.a, ['rev-parse', 'HEAD']); const sibling = git(graph.trees.b, ['rev-parse', 'HEAD']);
  expect(() => graph.integration.commitWorkspace({ id: 'foreign-worktree', taskId: graph.graphId, nodeId: 'a', instanceId: graph.instance('a'), recipe: 'coder@1',
    workspace: graph.trees.b, paths: ['other.txt'], message: 'Must refuse the sibling worktree' })).toThrow(/admitted node worktree/);
  expect(git(graph.trees.a, ['rev-parse', 'HEAD'])).toBe(first); expect(git(graph.trees.b, ['rev-parse', 'HEAD'])).toBe(sibling);
  expect(await readFile(join(graph.trees.b, 'other.txt'), 'utf8')).toBe('sibling private edit\n');
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
}, 30000);
