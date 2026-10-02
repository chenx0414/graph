// A failed check must point at the record that holds its whole run.
//
// Failure mode this file exists for: a `graph.command` check wrote everything it saw - command, args,
// exit code, stdout, stderr, and whether it ran inside the sandbox - to
// `<scratch>/checks/<nodeId>.json`, and then reported a failure as `{code, stderr: last 4000
// characters}`. The record was on disk and nothing said where it was; stdout, which is where a suite
// names the case that failed, was dropped entirely. Reading a failure meant searching the filesystem
// for a file the harness had already written and already knew the path of.
//
// The record path is the one a passing run registers as its acceptance evidence, so naming it on
// failure keeps both ends of a check pointing at the same file.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec , Proposal } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

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
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

const work: ActionAdapter = {
  kind: 'agent', reserveTokens: 100,
  prepare: async operation => async () => {
    await mkdir(join(operation.workspace!, 'scripts'), { recursive: true });
    await writeFile(join(operation.workspace!, 'scripts', 'fail.mjs'), FAILING);
    return { outcome: 'completed', output: null, usage };
  },
};

const nodes: NodeSpec[] = [
  { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['scripts/fail.mjs'] } },
];

async function failingRun() {
  const root = await repo();
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: { work } });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the check',
    acceptance: [{ id: 'tests', description: 'Tests pass', checkNode: 'check' }],
    nodes,
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const row = store.db.prepare('SELECT result FROM operations WHERE node_id=? AND result IS NOT NULL ORDER BY dispatched_at DESC LIMIT 1')
    .get('check') as { result: string };
  const question = store.db.prepare('SELECT kind,data FROM questions WHERE node_id=? ORDER BY rowid DESC LIMIT 1')
    .get('check') as { kind: string; data: string } | undefined;
  return {
    output: (JSON.parse(row.result) as { output: {
      code: number; stderr: string; stdoutTail?: string; record?: { path: string; digest: string };
    } }).output,
    question: question && { kind: question.kind, data: JSON.parse(question.data) as { output?: { record?: { path: string } } } },
    root,
  };
}

test('a failed check names the record that holds its whole run', async () => {
  const { output } = await failingRun();
  expect(output.code).toBe(3);
  expect(output.stderr).toContain('1 test failed');
  // Where the whole run lives, named by the failure itself.
  expect(output.record?.path, 'a failure must say where its record is').toBeTruthy();
  expect(existsSync(output.record!.path), `${output.record!.path} should exist`).toBe(true);
  // And the digest identifies that file, so a reader can tell the summary from the whole thing.
  const body = await readFile(output.record!.path, 'utf8');
  expect(createHash('sha256').update(body).digest('hex')).toBe(output.record!.digest);
  const recorded = JSON.parse(body) as { code: number; stdout: string; stderr: string };
  expect(recorded.code).toBe(3);
  expect(recorded.stderr).toContain('1 test failed');
  // stdout is where the failing case is named; the summary kept it, so the hunt is not needed.
  expect(recorded.stdout).toContain('widget renders a caret');
  expect(output.stdoutTail).toContain('widget renders a caret');
});

test('the failure main is woken for carries the record path too', async () => {
  const { question, output } = await failingRun();
  expect(question?.kind).toBe('execution_failed');
  // The question is what main reads; a path that only exists in an operation row is not reachable.
  expect(question!.data.output?.record?.path).toBe(output.record?.path);
});
