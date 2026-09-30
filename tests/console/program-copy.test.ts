// Why a check that runs the project's own command needs a prepared copy, pinned as behaviour.
//
// Failure mode this file exists for: `node --run check` is the project's own suite, and it is not
// location independent. Run under the host's state directory it cannot pass - the suite reads sibling
// repositories next to the project root, and it hands `node_modules` to the sandbox as a grant, which
// the sandbox refuses while that path is a link. Measured on this repository at 56cd786: 127 of 1480
// tests failed under the state directory and 0 failed in a copy beside the project root. A check that
// declares `copy: 'project'` therefore runs in a prepared worktree beside the project root, with the
// one install hardlinked in.

import { lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec } from '../../src/core/types.ts';
import { git as runGit, revParse } from '../../src/git/git.ts';
import { prepareProjectCopy, projectCopyPath } from '../../src/runtime/program-copy.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

/** Reports what only the run's own location can tell: where it ran, and what it can reach from there. */
const PROBE = [
  "import { existsSync, lstatSync } from 'node:fs';",
  "import { join } from 'node:path';",
  'console.log(JSON.stringify({',
  '  cwd: process.cwd(),',
  "  nodes: lstatSync('node_modules').isSymbolicLink() ? 'link' : 'files',",
  "  sibling: existsSync(join('..', 'sibling-repo', 'marker.txt')),",
  '}));',
  '',
].join('\n');

const checkNode: NodeSpec = { id: 'check', kind: 'program', action: 'graph.command' };
const noActions: Record<string, ActionAdapter> = {};

/** A project whose parent holds a sibling repository, exactly as the real workspace does. */
async function workspace() {
  const parent = await mkdtemp(join(tmpdir(), 'graph-program-copy-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'project');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(parent, 'sibling-repo'), { recursive: true });
  await writeFile(join(parent, 'sibling-repo', 'marker.txt'), 'sibling\n');
  await writeFile(join(root, 'scripts', 'probe.mjs'), PROBE);
  // The one install the project has, so a copy has something to hardlink.
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'export default 1;\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return { parent, root };
}

async function run(root: string, input: unknown) {
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: noActions });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the check',
    acceptance: [{ id: 'tests', description: 'Tests pass', checkNode: 'check' }],
    nodes: [{ ...checkNode, input: input as import('../../src/core/types.ts').Json }],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  return task.view();
}

test('a check that asks for the project copy runs beside the project root, on real dependencies', async () => {
  const { parent, root } = await workspace();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'], copy: 'project' });
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  expect(evidence).toMatchObject({ valid: true, nodeId: 'check' });
  const probe = JSON.parse((JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { stdout: string }).stdout) as {
    cwd: string; nodes: string; sibling: boolean;
  };
  // Beside the project root, not under the host's state directory: that is what lets the project's
  // own suite reach the sibling repositories it reads. Both sides are resolved, because a temporary
  // directory on this platform is reached through a symlinked prefix.
  expect(probe.cwd).toBe(await realpath(join(parent, '.graph-check-project-check')));
  expect(probe.sibling).toBe(true);
  // Ordinary files, not a link: the sandbox refuses a grant whose path is not already canonical, and
  // a linked node_modules reads back as a different path.
  expect(probe.nodes).toBe('files');
  expect(lstatSync(join(probe.cwd, 'node_modules')).isSymbolicLink()).toBe(false);
});

test('the copy is a working space beside the project, and the project keeps its own dependencies', async () => {
  const { root } = await workspace();
  await run(root, { command: 'node', args: ['scripts/probe.mjs'], copy: 'project' });
  // The install the project owns is untouched: a hardlinked copy shares files, it does not move them.
  expect(lstatSync(join(root, 'node_modules', 'pkg', 'index.js')).isSymbolicLink()).toBe(false);
  expect(await readFile(join(root, 'node_modules', 'pkg', 'index.js'), 'utf8')).toContain('export default');
  // And the project's own checkout was not turned into a worktree of itself.
  expect(lstatSync(join(root, 'node_modules')).isDirectory()).toBe(true);
});

test('without the declaration the check still runs in the node own work copy', async () => {
  const { root } = await workspace();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'] });
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  const probe = JSON.parse((JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { stdout: string }).stdout) as {
    cwd: string; sibling: boolean;
  };
  expect(probe.cwd).toContain('worktrees');
  expect(probe.cwd.startsWith(await realpath(root))).toBe(true);
});

test('a copy declaration the harness does not know is refused rather than ignored', async () => {
  const { root } = await workspace();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'], copy: 'somewhere' });
  expect(view.nodes.find(node => node.id === 'check')?.status).not.toBe('succeeded');
});

test('the copy is reused while its commit is unchanged, and rebuilt when it moves', async () => {
  // The copy is keyed on the committed state it was made from, so a retry of the same gate does not
  // pay to rebuild it, and a new integration commit never checks out the previous one by accident.
  const { root } = await workspace();
  const source = revParse(root, 'HEAD')!;
  const first = await prepareProjectCopy({ projectRoot: root, source: root, label: 'check' });
  expect(first).toBe(projectCopyPath(root, 'check'));
  const marker = join(first!, 'left-behind.txt');
  await writeFile(marker, 'kept\n');
  const again = await prepareProjectCopy({ projectRoot: root, source: root, label: 'check' });
  expect(await readFile(join(again!, 'left-behind.txt'), 'utf8')).toBe('kept\n');
  await writeFile(join(root, 'second.txt'), 'second\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'second']);
  expect(revParse(root, 'HEAD')).not.toBe(source);
  const moved = await prepareProjectCopy({ projectRoot: root, source: root, label: 'check' });
  expect(moved).toBe(first);
  await expect(readFile(join(moved!, 'left-behind.txt'), 'utf8')).rejects.toThrow();
  expect(await readFile(join(moved!, 'second.txt'), 'utf8')).toBe('second\n');
});

test('a work copy with nothing committed has no version to check out elsewhere', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'graph-program-copy-empty-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const bare = join(parent, 'project');
  await mkdir(bare, { recursive: true });
  git(bare, ['init', '-b', 'main']);
  expect(await prepareProjectCopy({ projectRoot: bare, source: bare, label: 'check' })).toBeUndefined();
});
