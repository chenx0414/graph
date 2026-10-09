import { lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { TaskStore } from '../../src/core/store.ts';
import { GitIntegration } from '../../src/git/integration.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args); if (result.code !== 0) throw new Error(result.stderr); return result.stdout.trim();
}
const commit = (root: string, message: string) => git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', message]);
async function workspace(committed = true) {
  const parent = await mkdtemp(join(tmpdir(), 'graph-native-command-copy-')); cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'project'); await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), "module.exports='installed dependency';\n");
  await writeFile(join(root, '.gitignore'), 'node_modules/\nstate/\n'); await writeFile(join(root, 'version.txt'), 'v1');
  await writeFile(join(root, 'probe.cjs'), "const fs=require('fs');console.log(JSON.stringify({cwd:process.cwd(),nodes:fs.lstatSync('node_modules').isSymbolicLink(),dependency:require('pkg'),version:fs.readFileSync('version.txt','utf8')}));\n");
  git(root, ['init', '-q', '-b', 'main']);
  if (committed) { git(root, ['add', '.']); commit(root, 'baseline'); }
  return { parent, root };
}
async function run(root: string, extra: Record<string, unknown> = {}) {
  const data = { protocol: 'data' };
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Native command workspace', protocols: { data: { type: 'object' } }, nodes: {},
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['probe.cjs'], output: 'result', ...extra } } },
    edges: {}, acceptance: [{ id: 'tests', description: 'Project command can read the installed dependency and committed version', kind: 'check', module: 'check' }] });
  const stateDir = join(root, 'state'); const capabilityRoot = join(stateDir, 'capabilities'); await mkdir(capabilityRoot, { recursive: true });
  const runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'p', root }], catalog: { capabilityRoot, recipesPath: join(stateDir, 'recipes.json') } });
  cleanup.push(() => runtime.close());
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare' });
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Run the formal host check', requestId: 'begin' }); const main = runtime.supervisor(owner.taskId);
  const { graphId } = await main.graphCreate({ targetBranch: 'main', definition }) as { graphId: string };
  const disk = new TaskStore(join(stateDir, 'tasks.sqlite')); cleanup.push(() => disk.close());
  return { runtime, main, graphId, disk, async check() {
    await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
    const row = disk.db.prepare('SELECT id,result FROM kernel_module_operations WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(graphId) as { id: string; result: string };
    const result = JSON.parse(row.result).outputs.result as { passed: boolean; stdout: string; stderr: string; verifiedCommit: string };
    expect(result.passed, result.stderr).toBe(true);
    const probe = JSON.parse(result.stdout) as { cwd: string; nodes: boolean; dependency: string; version: string };
    await expect(main.graphInspect({ graphId, query: 'acceptance' })).resolves.toMatchObject({ items: [{ id: 'tests', status: 'passed', source: { id: row.id, commit: result.verifiedCommit } }] });
    return { id: row.id, result, probe };
  } };
}

test('a native host check resolves the actual installed dependency from the integration worktree', async () => {
  const { root } = await workspace(); const graph = await run(root); const { probe } = await graph.check();
  const integration = graph.disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graph.graphId}`) as { path: string };
  expect(probe.cwd).toBe(await realpath(integration.path));
  expect(probe.nodes).toBe(true); expect(probe.dependency).toBe('installed dependency');
  expect(await realpath(join(probe.cwd, 'node_modules'))).toBe(await realpath(join(root, 'node_modules')));
});

test('native command dependency linking preserves the project installation and checkout', async () => {
  const { root } = await workspace(); const original = git(root, ['rev-parse', 'HEAD']); const graph = await run(root); await graph.check();
  expect(lstatSync(join(root, 'node_modules')).isSymbolicLink()).toBe(false);
  expect(await readFile(join(root, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe("module.exports='installed dependency';\n");
  expect(git(root, ['rev-parse', 'HEAD'])).toBe(original); expect(git(root, ['status', '--porcelain'])).toBe('');
});

test('the formal check receipt names the exact integration commit it executed', async () => {
  const { root } = await workspace(); const graph = await run(root); const { result, probe } = await graph.check();
  expect(result.verifiedCommit).toBe(graph.disk.task(graph.graphId).integration_sha);
  expect(git(probe.cwd, ['rev-parse', 'HEAD'])).toBe(result.verifiedCommit); expect(probe.version).toBe('v1');
});

test('legacy copy declarations are rejected rather than silently accepted by a native operation', async () => {
  const { root } = await workspace();
  for (const copy of ['project', 'somewhere']) await expect(run(root, { copy })).rejects.toThrow(/unsupported operation field copy/);
});

test('repeated native checks reuse the workspace and read an advanced integration version after explicit input', async () => {
  const { root } = await workspace(); const graph = await run(root); const first = await graph.check(); const second = await graph.check();
  expect(second.probe.cwd).toBe(first.probe.cwd); expect(second.result.verifiedCommit).toBe(first.result.verifiedCommit); expect(second.id).not.toBe(first.id);
  await writeFile(join(root, 'version.txt'), 'v2'); git(root, ['add', 'version.txt']); commit(root, 'advance target');
  const moved = new GitIntegration(graph.disk, join(root, 'state')).tryDeliver(graph.graphId, first.result.verifiedCommit);
  expect(moved.status).toBe('recheck');
  const third = await graph.check(); expect(third.probe.cwd).toBe(first.probe.cwd); expect(third.probe.version).toBe('v2');
  expect(third.result.verifiedCommit).toBe(git(root, ['rev-parse', 'HEAD'])); expect(third.result.verifiedCommit).not.toBe(first.result.verifiedCommit);
});

test('formal preparation creates a committed baseline before checking previously uncommitted files', async () => {
  const { root } = await workspace(false);
  expect(runGit(root, ['rev-parse', '--verify', 'HEAD']).code).not.toBe(0);
  const graph = await run(root); const { result, probe } = await graph.check();
  expect(result.verifiedCommit).toBe(git(root, ['rev-parse', 'HEAD'])); expect(probe.version).toBe('v1');
  expect(git(root, ['ls-tree', '-r', '--name-only', 'HEAD'])).toContain('probe.cjs');
  expect(git(root, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('node_modules');
});
