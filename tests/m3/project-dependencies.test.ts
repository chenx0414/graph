import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { commitAll, ensureWorktree, git as runGit, initRepo } from '../../src/git/git.ts';
import { linkProjectDependencies } from '../../src/runtime/project-dependencies.ts';
import { openWorkspaceCommandRunner } from '../../src/runtime/workspace-command.ts';
import type { RestrictedGate } from '../../src/runtime/restricted-process.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/** A gate that always lets the command through. */
function gate(): RestrictedGate {
  return { dispatch: (_id, _reservation, send) => send(), settle: () => {} };
}

/** A project that installed one dependency with its own toolchain. */
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'graph-deps-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'project');
  const pkg = join(repo, 'node_modules', 'fixture-dep');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-dep', main: 'index.js' }));
  await writeFile(join(pkg, 'index.js'), 'module.exports = { answer: 42 };\n');
  await writeFile(join(repo, 'README.md'), 'project\n');
  return { root, repo };
}

test('a worker command resolves the project install linked into its work copy', async () => {
  const { root, repo } = await project();
  const copy = join(root, 'worktrees', 'worker');
  await mkdir(copy, { recursive: true });
  const modules = await linkProjectDependencies(copy, join(repo, 'node_modules'));
  expect(modules).toBe(await realpath(join(repo, 'node_modules')));
  await writeFile(join(copy, 'probe.mjs'), [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(import.meta.url);",
    "console.log(require('fixture-dep').answer);",
  ].join('\n'));

  const granted = await openWorkspaceCommandRunner({ workspace: copy, scratchDir: join(root, 'scratch-a'), readPaths: [modules!], gate: gate() });
  cleanup.push(() => granted.close());
  const resolved = await granted.run('node', ['probe.mjs']);
  expect(resolved.code, resolved.stderr).toBe(0);
  expect(resolved.stdout.trim()).toBe('42');

  // The link points outside the work copy, so the sandbox grant is what makes
  // the dependency readable; without it the same command must fail.
  const ungranted = await openWorkspaceCommandRunner({ workspace: copy, scratchDir: join(root, 'scratch-b'), gate: gate() });
  cleanup.push(() => ungranted.close());
  const blocked = await ungranted.run('node', ['probe.mjs']);
  expect(blocked.code).not.toBe(0);
});

test('a work copy without installed dependencies links nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-deps-empty-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, 'copy');
  await mkdir(copy);
  expect(await linkProjectDependencies(copy, join(root, 'project', 'node_modules'))).toBeUndefined();
});

test('the linked install never reaches a work-copy commit', async () => {
  const { root, repo } = await project();
  initRepo(repo);
  commitAll(repo, 'baseline', { name: 'Graph', email: 'graph@localhost' });
  const copy = join(root, 'worktrees', 'worker');
  ensureWorktree(repo, copy, 'graph/copy/test/worker', 'HEAD');
  await linkProjectDependencies(copy, join(repo, 'node_modules'));

  // The host link is invisible to Git, so a worker's own commit cannot ship an
  // absolute developer path to the integration or target branch.
  expect(runGit(copy, ['status', '--porcelain']).stdout).toBe('');
  await writeFile(join(copy, 'work.txt'), 'worker change\n');
  commitAll(copy, 'worker change', { name: 'Bob_coder', email: 'bob@graph.local' });
  const files = runGit(copy, ['show', '--name-only', '--format=', 'HEAD']).stdout.split('\n').filter(Boolean);
  expect(files).toEqual(['work.txt']);
});
