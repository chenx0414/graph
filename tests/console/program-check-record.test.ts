// A failed check must point at the record that holds its whole run.
//
// Failure mode this file exists for: a `workspace.command` check wrote everything it saw - command, args,
// exit code, stdout, stderr, and whether it ran inside the sandbox - to
// `<scratch>/checks/<nodeId>.json`, and then reported a failure as `{code, stderr: last 4000
// characters}`. The record was on disk and nothing said where it was; stdout, which is where a suite
// names the case that failed, was dropped entirely. Reading a failure meant searching the filesystem
// for a file the harness had already written and already knew the path of.
//
// Native operations keep the same record contract on pass and failure. The public output carries
// its reference to main; the digest belongs to operation audit metadata, not the business protocol.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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

/** Prints to both channels and exits 3, so the record holds more than the failure summary does. */
const FAILING = [
  'console.log("the suite names its first failing case here: widget renders a caret");',
  'console.error("1 test failed");',
  'process.exit(3);',
  '',
].join('\n');

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-check-record-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  await writeFile(join(root, '.gitignore'), 'state/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

async function failingRun() {
  const root = await repo();
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'fail.mjs'), FAILING);
  git(root, ['add', 'scripts']);
  git(root, ['commit', '-m', 'check fixture']);
  const briefings: string[] = [];
  const checked = await runWorkspaceCheck({ workspace: root, command: { command: 'node', args: ['scripts/fail.mjs'] },
    mainAction: { kind: 'agent', reserveTokens: 1, prepare: async operation => async () => {
      briefings.push(operation.context.briefing ?? '');
      return { outcome: 'completed', output: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    } },
  });
  cleanup.push(() => checked.runtime.close());
  const output = await workspaceCheckOutput(checked);
  const operations = await checked.main.graphInspect({ graphId: checked.graphId, query: 'operations' }) as { record_digest?: string | null }[];
  return { checked, output, digest: operations[0]!.record_digest, briefings };
}

test('a failed check names and fingerprints the record that holds its whole run', async () => {
  const { output, digest } = await failingRun();
  expect(output.passed).toBe(false);
  expect(output.code).toBe(3);
  expect(output.stderr).toContain('1 test failed');
  expect(existsSync(output.record)).toBe(true);
  const body = await readFile(output.record, 'utf8');
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(createHash('sha256').update(body).digest('hex')).toBe(digest);
  const recorded = JSON.parse(body) as { code: number; stdout: string; stderr: string };
  expect(recorded.code).toBe(3);
  expect(recorded.stderr).toContain('1 test failed');
  expect(recorded.stdout).toContain('widget renders a caret');
  expect(output.stdout).toContain('widget renders a caret');
});

test('main receives the failed business result with its actual record reference', async () => {
  const { checked, output, briefings } = await failingRun();
  const results = await checked.main.graphInspect({ graphId: checked.graphId, query: 'results' }) as { id: string; value: { passed: boolean; record: string } }[];
  expect(results).toHaveLength(1);
  expect(results[0]!.value).toMatchObject({ passed: false, record: output.record });
  expect(briefings.some(text => text.includes(`result ${results[0]!.id}`))).toBe(true);
});
