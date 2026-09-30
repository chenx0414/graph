// A full-access check can use whatever git its own PATH resolves to, pinned as behaviour.
//
// This was written to hunt a suspected sandbox denial (the platform git needs
// /Library/Developer/CommandLineTools, which the confined profile grants explicitly). The hunt came
// up empty - the check creates a repository both inside its work copy and under the scratch directory,
// through /usr/bin/git, with no denial - and that negative result is worth keeping: it is a boundary
// somebody will suspect again, and this file says it was measured.
//
// The check spawns git itself rather than being `command: 'git'`, because that is the difference
// that matters: the harness resolves a command against the host PATH, while a command the check
// spawns gets the sandbox's PATH, which is how the project's own suite ends up on the platform shim.
//
// Not covered here, and still open as HB-221: inside the sandbox the same suite fails 224 of its
// tests and hits its own timeouts, so "run the whole suite under the sandbox" does not complete.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-host-git-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

/** Creates a repository the way a suite does when it sets up a throwaway one: under TMPDIR, which
 * the harness points at its own scratch directory, by spawning `git` through PATH. */
const MAKEREPO = [
  "import { spawnSync } from 'node:child_process';",
  "import { mkdtempSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();",
  "const dir = mkdtempSync(join(tmpdir(), 'graph-baseline-'));",
  "const made = spawnSync('git', ['init', dir], { encoding: 'utf8' });",
  'console.log(JSON.stringify({ git, dir, status: made.status }));',
  "if (made.stderr) process.stderr.write(made.stderr);",
  'process.exit(made.status ?? 1);',
  '',
].join('\n');

const nodes: NodeSpec[] = [
  { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'] },
];

const work: ActionAdapter = {
  kind: 'agent', reserveTokens: 100,
  prepare: async operation => async () => {
    await mkdir(join(operation.workspace!, 'scripts'), { recursive: true });
    await writeFile(join(operation.workspace!, 'scripts', 'mkrepo.mjs'), MAKEREPO);
    return { outcome: 'completed', output: null, usage };
  },
};

test('a full-access check creates a repository with the git its own PATH resolves to', async () => {
  const root = await repo();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: { work },
    access: () => fullAccessPolicy(),
  });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the check',
    acceptance: [{ id: 'tests', description: 'Tests pass', checkNode: 'check' }],
    nodes: nodes.map(node => node.id === 'check' ? { ...node, input: { command: 'node', args: ['scripts/mkrepo.mjs'] } } : node),
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await task.view();
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  expect(evidence).toMatchObject({ valid: true, nodeId: 'check' });
  const body = JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { code: number; stdout: string; stderr: string };
  expect(body.code).toBe(0);
  expect(body.stderr).not.toContain('Operation not permitted');
  const report = JSON.parse(body.stdout.trim()) as { git: string; dir: string; status: number };
  expect(report.status).toBe(0);
  // The check reached the platform shim - the case that was suspected of being denied - and the
  // repository landed in the harness's own scratch directory.
  expect(report.git).toBe('/usr/bin/git');
  expect(report.dir).toContain('checks');
});
