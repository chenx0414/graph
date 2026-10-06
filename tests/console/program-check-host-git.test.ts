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
import { runWorkspaceCheck, workspaceCheckOutput } from '../fixtures/workspace-check.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

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

test('a full-access check creates a repository with the git its own PATH resolves to', async () => {
  const root = await repo();
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'mkrepo.mjs'), MAKEREPO);
  const checked = await runWorkspaceCheck({ workspace: root, command: { command: 'node', args: ['scripts/mkrepo.mjs'] }, fullAccess: true });
  cleanup.push(() => checked.runtime.close());
  const output = await workspaceCheckOutput(checked);
  const body = JSON.parse(await readFile(output.record, 'utf8')) as { code: number; stdout: string; stderr: string };
  expect(body.code).toBe(0);
  expect(body.stderr).not.toContain('Operation not permitted');
  const report = JSON.parse(body.stdout.trim()) as { git: string; dir: string; status: number };
  expect(report.status).toBe(0);
  expect(report.git).toBe('/usr/bin/git');
  expect(await readFile(join(report.dir, '.git', 'HEAD'), 'utf8')).toContain('refs/heads/');
});
