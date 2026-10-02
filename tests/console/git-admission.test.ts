import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter , Proposal } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';
import { withLiftedDefinition } from '../fixtures/v2-lift.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
function shell(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

async function project(name: string, options: { git?: boolean; subdir?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), `graph-git-admission-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  if (options.git) {
    shell(root, ['init', '-b', 'main']);
    await writeFile(join(root, 'README.md'), 'project\n');
    shell(root, ['add', 'README.md']);
    shell(root, ['commit', '-m', 'init']);
  }
  const rootPath = options.subdir ? join(root, 'project') : root;
  if (options.subdir) await mkdir(rootPath, { recursive: true });
  return { root, rootPath };
}

async function runtimeFor(rootPath: string, actions: Record<string, ActionAdapter>, master = false) {
  const runtime = await openTaskRuntime({
    stateDir: join(rootPath, 'state'), projects: [{ id: 'p', root: rootPath }], actions,
    ...(master ? { master: { action: 'master', definitionVersion: 'master@1', model: 'scripted' } } : {}),
  });
  cleanup.push(() => runtime.close());
  return runtime;
}

async function taskFor(runtime: Awaited<ReturnType<typeof runtimeFor>>) {
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Work', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose(withLiftedDefinition({
    requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  } as Proposal), 'proposal');
  return { taskId, task: runtime.user.task(taskId), proposalVersion: proposed.proposalVersion };
}

const checkAction: ActionAdapter = { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: '/tmp/ok', digest: 'a'.repeat(64) } }] }) };

test('a plain directory is initialized with a local baseline and no remote', async () => {
  const { rootPath } = await project('plain');
  await writeFile(join(rootPath, 'app.js'), 'console.log(1)\n');
  const runtime = await runtimeFor(rootPath, {});
  const first = await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare-1' });
  expect(first).toMatchObject({ state: 'ready', projectSubdir: '', baselineSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
  expect(first.repoRoot).toBe(await realpath(rootPath));
  expect(shell(rootPath, ['rev-parse', '--verify', 'HEAD'])).toBe(first.baselineSha);
  expect(shell(rootPath, ['branch', '--show-current'])).toBe('main');
  expect(shell(rootPath, ['remote'])).toBe('');
  expect(shell(rootPath, ['log', '--oneline']).split('\n')).toHaveLength(1);
  expect(await readFile(join(rootPath, 'app.js'), 'utf8')).toBe('console.log(1)\n');

  // Idempotent: a second prepare keeps the same baseline and does not recommit.
  const second = await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare-2' });
  expect(second.baselineSha).toBe(first.baselineSha);
  expect(shell(rootPath, ['log', '--oneline']).split('\n')).toHaveLength(1);
  // Cursor events are idempotent per requestId.
  expect(await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare-2' })).toEqual(second);
}, 60_000);

test('an empty directory receives an empty baseline commit', async () => {
  const { rootPath } = await project('empty');
  const runtime = await runtimeFor(rootPath, {});
  const prep = await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare' });
  expect(prep.state).toBe('ready');
  expect(prep.baselineSha).toBeTruthy();
  expect(shell(rootPath, ['rev-parse', 'HEAD'])).toBe(prep.baselineSha);
  expect(shell(rootPath, ['ls-files'])).toBe('');
}, 60_000);

test('sensitive and generated files stay out of the baseline but on disk', async () => {
  const { rootPath } = await project('sensitive');
  await writeFile(join(rootPath, '.env'), 'SECRET=1\n');
  await mkdir(join(rootPath, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(rootPath, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n');
  await writeFile(join(rootPath, 'index.js'), 'module.exports = 2\n');
  shell(rootPath, ['init', '-b', 'main']);
  const runtime = await runtimeFor(rootPath, {});
  const prep = await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare' });
  expect(prep.state).toBe('ready');
  const files = shell(rootPath, ['ls-files']).split('\n').sort();
  expect(files).toEqual(['index.js']);
  expect(await readFile(join(rootPath, '.env'), 'utf8')).toBe('SECRET=1\n');
  expect(await stat(join(rootPath, 'node_modules', 'pkg', 'index.js'))).toBeTruthy();
}, 60_000);

test('project path completion returns visible files and folders without sensitive paths', async () => {
  const { rootPath } = await project('path-completion');
  await mkdir(join(rootPath, 'src', 'components'), { recursive: true });
  await writeFile(join(rootPath, 'src', 'index.ts'), 'export {};\n');
  await writeFile(join(rootPath, 'src', 'components', 'Button.tsx'), 'export const Button = 1;\n');
  await writeFile(join(rootPath, 'README.md'), '# project\n');
  await writeFile(join(rootPath, '.env'), 'SECRET=1\n');
  await mkdir(join(rootPath, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(rootPath, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  const runtime = await runtimeFor(rootPath, {});

  const all = runtime.projectEntries('p', '', 100);
  expect(all).toContainEqual({ path: 'src', kind: 'directory' });
  expect(all).toContainEqual({ path: 'src/index.ts', kind: 'file' });
  expect(all).toContainEqual({ path: 'src/components', kind: 'directory' });
  expect(all).toContainEqual({ path: 'README.md', kind: 'file' });
  expect(all.some(entry => entry.path.includes('.env'))).toBe(false);
  expect(all.some(entry => entry.path.includes('node_modules'))).toBe(false);
  expect(all.some(entry => entry.path.startsWith('state'))).toBe(false);
  expect(runtime.projectEntries('p', 'button', 20)).toEqual([{ path: 'src/components/Button.tsx', kind: 'file' }]);
}, 60_000);

test('a clean repository with HEAD is ready without a new commit', async () => {
  const { rootPath } = await project('clean', { git: true });
  const before = shell(rootPath, ['rev-parse', 'HEAD']);
  const runtime = await runtimeFor(rootPath, {});
  const prep = await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare' });
  expect(prep).toMatchObject({ state: 'ready', baselineSha: before });
  expect(shell(rootPath, ['rev-parse', 'HEAD'])).toBe(before);
  expect(shell(rootPath, ['log', '--oneline']).split('\n')).toHaveLength(1);
}, 60_000);

test('a dirty repository blocks formal dispatch until an explicit baseline', async () => {
  const { rootPath } = await project('dirty', { git: true });
  await writeFile(join(rootPath, 'uncommitted.txt'), 'user work\n');
  let sends = 0;
  const work: ActionAdapter = { kind: 'agent', reserveTokens: 100, prepare: async () => async () => { sends += 1; return { outcome: 'completed', output: null, usage }; } };
  const runtime = await runtimeFor(rootPath, { work, check: checkAction });
  const prep = await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare' });
  expect(prep.state).toBe('detected');
  expect((prep.detail as { dirty?: number }).dirty).toBeGreaterThan(0);
  const { task, proposalVersion } = await taskFor(runtime);
  await expect(task.accept({ proposalVersion, targetBranch: 'main', requestId: 'accept' }))
    .rejects.toMatchObject({ code: 'project_dirty' });
  expect(sends).toBe(0);
  expect(await readFile(join(rootPath, 'uncommitted.txt'), 'utf8')).toBe('user work\n');

  // The user explicitly chooses to snapshot the current work as the baseline.
  const baseline = await runtime.projects.prepare({ projectId: 'p', requestId: 'baseline', createBaseline: true });
  expect(baseline.state).toBe('ready');
  expect(shell(rootPath, ['ls-files'])).toContain('uncommitted.txt');
  await task.accept({ proposalVersion, targetBranch: 'main', requestId: 'accept-2' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(sends).toBe(1);
}, 60_000);

test('a repository without HEAD gets a baseline before dispatch', async () => {
  const { rootPath } = await project('no-head');
  shell(rootPath, ['init', '-b', 'main']);
  await writeFile(join(rootPath, 'first.txt'), 'first\n');
  let workspace = '';
  const work: ActionAdapter = { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => { workspace = operation.workspace!; return { outcome: 'completed', output: null, usage }; } };
  const runtime = await runtimeFor(rootPath, { work, check: checkAction });
  const prep = await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare' });
  expect(prep.state).toBe('ready');
  expect(shell(rootPath, ['rev-parse', 'HEAD'])).toBe(prep.baselineSha);
  const { task, proposalVersion } = await taskFor(runtime);
  await task.accept({ proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(workspace).not.toBe(rootPath);
  expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe('first\n');
}, 60_000);

test('a repository subdirectory keeps its scope without creating a nested repo', async () => {
  const { root, rootPath } = await project('subdir', { git: true, subdir: true });
  await writeFile(join(rootPath, 'sub.txt'), 'sub\n');
  shell(root, ['add', '.']);
  shell(root, ['commit', '-m', 'sub']);
  let workspace = '';
  const work: ActionAdapter = { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => { workspace = operation.workspace!; await writeFile(join(workspace, 'sub.txt'), 'changed\n'); return { outcome: 'completed', output: null, usage }; } };
  const runtime = await runtimeFor(rootPath, { work, check: checkAction });
  const prep = await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare' });
  expect(prep).toMatchObject({ state: 'ready', repoRoot: await realpath(root), projectSubdir: 'project' });
  const { task, proposalVersion } = await taskFor(runtime);
  await task.accept({ proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  // The worker starts inside the project subdirectory of the work copy.
  expect(relative(join(await realpath(rootPath), 'state', 'worktrees'), workspace).startsWith('..')).toBe(false);
  expect(workspace.endsWith('/project')).toBe(true);
  expect(await readFile(join(workspace, 'sub.txt'), 'utf8')).toBe('changed\n');
  await expect(stat(join(rootPath, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);

test('direct acceptance cannot fall back to the project root without Git', async () => {
  const { rootPath } = await project('no-fallback');
  await writeFile(join(rootPath, 'business.txt'), 'business\n');
  let workspace = '';
  const work: ActionAdapter = { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => { workspace = operation.workspace!; await writeFile(join(workspace, 'written.txt'), 'isolated\n'); return { outcome: 'completed', output: null, usage }; } };
  const runtime = await runtimeFor(rootPath, { work, check: checkAction });
  const { task, proposalVersion } = await taskFor(runtime);
  // No explicit prepare call: the host initializes the plain directory at the
  // formal acceptance boundary instead of silently dispatching in place.
  await task.accept({ proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(workspace).not.toBe(rootPath);
  expect(workspace.startsWith(join(await realpath(rootPath), 'state', 'worktrees'))).toBe(true);
  expect(await readFile(join(workspace, 'written.txt'), 'utf8')).toBe('isolated\n');
  await expect(readFile(join(rootPath, 'written.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);

test('an unknown target branch fails before acceptance without touching the project', async () => {
  const { rootPath } = await project('branch', { git: true });
  const before = shell(rootPath, ['rev-parse', 'HEAD']);
  const runtime = await runtimeFor(rootPath, {});
  const { task, proposalVersion } = await taskFor(runtime);
  await expect(task.accept({ proposalVersion, targetBranch: 'missing-branch', requestId: 'accept' }))
    .rejects.toMatchObject({ code: 'invalid_input' });
  const view = await task.view();
  expect(view.acceptedProposalVersion).toBeNull();
  expect(view.targetBranch).toBeNull();
  expect(shell(rootPath, ['rev-parse', 'HEAD'])).toBe(before);
}, 60_000);
