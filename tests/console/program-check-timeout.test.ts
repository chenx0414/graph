// How long a program check may run, pinned as behaviour.
//
// Failure mode this file exists for: every `workspace.command` check was killed after two minutes, and
// the kill arrived as `Process terminated by SIGKILL` - which reads like a verdict on the work rather
// than a limit the harness imposed. The project's own suite needs about two and a half minutes, so a
// gate that runs it could never finish, whatever it was checking. Measured on task 68543fed: the two
// attempts at that gate were cut at 120s and 133s wall time, and an unsandboxed run of the same
// commit finished in 127-145s.
//
// A check may now declare `timeoutMs`; the default is unchanged, and a run that IS cut says so.

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

/** Sleeps for the milliseconds it is given, so a check can be asked to outlive its limit. */
const SLEEP = [
  'const ms = Number(process.argv[2] ?? 0);',
  'setTimeout(() => console.log(`slept ${ms}`), ms);',
  '',
].join('\n');

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-check-timeout-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

async function run(root: string, input: unknown) {
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'sleep.mjs'), SLEEP);
  const checked = await runWorkspaceCheck({ workspace: root, command: input });
  cleanup.push(() => checked.runtime.close());
  return workspaceCheckOutput(checked);
}

test('a check that finishes inside its declared limit is not killed', async () => {
  const root = await repo();
  const output = await run(root, { command: 'node', args: ['scripts/sleep.mjs', '700'], timeoutMs: 30_000 });
  const body = JSON.parse(await readFile(output.record, 'utf8')) as { code: number; stdout: string };
  expect(output.passed).toBe(true);
  expect(body.code).toBe(0);
  expect(body.stdout).toContain('slept 700');
});

test('a check that outlives its declared limit is cut, and the record says it was the limit', async () => {
  const root = await repo();
  const output = await run(root, { command: 'node', args: ['scripts/sleep.mjs', '30000'], timeoutMs: 2_000 });
  const body = JSON.parse(await readFile(output.record, 'utf8')) as { code: number | null; stderr: string };
  expect(output.passed).toBe(false);
  expect(output.code).toBeNull();
  expect(body.code).toBeNull();
  expect(body.stderr).toMatch(/timeout|exceeded/i);
  expect(body.stderr).toContain('2000');
});

test('a limit the harness cannot honour is refused rather than quietly replaced', async () => {
  for (const timeoutMs of [0, -1, 1.5, 'soon']) {
    const root = await repo();
    await expect(run(root, { command: 'node', args: ['scripts/sleep.mjs', '10'], timeoutMs })).rejects.toThrow(/invalid operation timeout/);
  }
});
